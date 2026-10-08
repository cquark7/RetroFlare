import { LIMITS, PROTOCOL_VERSION, RETRO_SCHEMA_VERSION } from "../src/shared/constants";
import type { RetroStatus } from "../src/shared/constants";
import {
  CreateRetroRequestSchema,
  JoinRetroRequestSchema,
  PostCommandsRequestSchema,
  RetroIdParamsSchema,
  RetroListQuerySchema,
  WebSocketHandshakeQuerySchema
} from "../src/shared/api";
import { AuthPrincipalSchema } from "../src/shared/auth";
import type { AuthPrincipal } from "../src/shared/auth";
import { RetroSchema, RetroSummarySchema } from "../src/shared/domain";
import type { Retro } from "../src/shared/domain";
import {
  AckMessageSchema,
  CommandErrorMessageSchema,
  ClientWebSocketFrameSchema,
  EventsMessageSchema,
  FinishProgressMessageSchema,
  FinishRequestedMessageSchema,
  GiphySharedMessageSchema,
  PresenceMessageSchema,
  RetroClosedMessageSchema,
  SnapshotMessageSchema,
  type GiphyShareRequest,
  type ClientCommand
} from "../src/shared/protocol";
import type { PersistedBoardEvent } from "../src/shared/events";
import { createApiError } from "../src/shared/errors";
import { executeCommand, isFinishProgressEvent, joinRetro, markClosingDeadlineReached } from "./commands";
import {
  exportAll,
  exportRetro,
  handleImport,
  handleImportPreview
} from "./backups";
import { BackendError, apiSuccess, errorResponse, parseJsonRequestBody, zodError } from "./http";
import {
  consumeRetroCreationBudget,
  indexPrefixForStatus,
  readRetro,
  summaryKey,
  StorageError,
  writeRetro
} from "./storage";
import {
  deserializeSocketAttachment,
  SocketAttachmentSchema,
  writeSocketAttachment
} from "./socket-types";
import type { SocketAttachment } from "./socket-types";

const TRUSTED_PRINCIPAL_HEADER = "x-retroflare-principal";
const AUTH_REQUIRED_CLOSE_CODE = 4001;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;
const ALARM_DEADLINE_BATCH = 100;

type CursorValue =
  | { group: "active" | "closed"; key: string }
  | { group: "status"; status: RetroStatus; key: string };

function encodeCursor(value: CursorValue): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): CursorValue {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const value: unknown = JSON.parse(decoded);
    if (
      !value ||
      typeof value !== "object" ||
      !("key" in value) ||
      typeof value.key !== "string"
    ) {
      throw new Error("Malformed cursor.");
    }
    const record = value as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== "string") throw new Error("Malformed cursor.");
    if (
      (record.group === "active" || record.group === "closed") &&
      key.startsWith(`index:${record.group === "active" ? "active" : "status:closed"}:`)
    ) {
      return { group: record.group, key };
    }
    if (
      record.group === "status" &&
      (record.status === "open" || record.status === "closing" || record.status === "closed") &&
      key.startsWith(indexPrefixForStatus(record.status))
    ) {
      return { group: "status", status: record.status, key };
    }
    throw new Error("Malformed cursor.");
  } catch {
    throw new BackendError("INVALID_REQUEST", "The history cursor is invalid.");
  }
}

function backendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof StorageError) return new BackendError(error.code, error.message);
  return new BackendError("INTERNAL_ERROR", "The retro operation could not be completed.");
}

function parsePrincipal(request: Request): AuthPrincipal {
  const header = request.headers.get(TRUSTED_PRINCIPAL_HEADER);
  if (!header) throw new BackendError("AUTH_REQUIRED", "A verified application identity is required.");
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(header);
  } catch {
    throw new BackendError("AUTH_REQUIRED", "A verified application identity is required.");
  }
  const parsed = AuthPrincipalSchema.safeParse(untrusted);
  if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) {
    throw new BackendError("AUTH_REQUIRED", "A verified application identity is required.");
  }
  return parsed.data;
}

function parseBody<T>(request: Request, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } }, maxBytes = LIMITS.incomingWebSocketFrameBytes): Promise<T> {
  return parseJsonRequestBody(request, maxBytes, (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw zodError(parsed.error);
    return parsed.data;
  });
}

function validRetroId(value: string): string {
  const parsed = RetroIdParamsSchema.safeParse({ id: value });
  if (!parsed.success) throw new BackendError("NOT_FOUND", "This retro does not exist.");
  return parsed.data.id;
}

function bytesOfFrame(message: string | ArrayBuffer): number {
  return typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
}

function messageToText(message: string | ArrayBuffer): string {
  return typeof message === "string"
    ? message
    : new TextDecoder("utf-8", { fatal: true }).decode(message);
}

function parseClientFrame(value: unknown) {
  const parsed = ClientWebSocketFrameSchema.safeParse(value);
  if (!parsed.success) throw zodError(parsed.error);
  return parsed.data;
}

function actorDisplayName(retro: Retro, actorId: string): string | undefined {
  return retro.participants[actorId]?.displayName;
}

function eventsChangeScheduledDeadline(events: readonly PersistedBoardEvent[]): boolean {
  return events.some((event) =>
    event.type === "retro.closing.started" ||
    event.type === "retro.closing.cancelled" ||
    event.type === "retro.closed"
  );
}

export class TeamRetro {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, environment: Env) {
    this.state = state;
    void environment;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const principal = parsePrincipal(request);
      return await this.route(request, principal);
    } catch (error) {
      return errorResponse(backendError(error));
    }
  }

  private async route(request: Request, principal: AuthPrincipal): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/api/retros" && request.method === "GET") {
      return this.listRetros(url);
    }
    if (path === "/api/retros" && request.method === "POST") {
      return this.createRetro(request, principal);
    }
    if (path === "/api/export" && request.method === "GET") {
      return await exportAll(this.state.storage, url);
    }
    if (path === "/api/import/preview" && request.method === "POST") {
      return await handleImportPreview(this.state, principal, request);
    }
    if (path === "/api/import" && request.method === "POST") {
      return await handleImport(this.state, principal, request);
    }

    const match = /^\/api\/retros\/([^/]+)(?:\/(join|ws|commands|export))?$/.exec(path);
    if (!match) throw new BackendError("NOT_FOUND", "The requested API route does not exist.");
    const retroId = validRetroId(match[1]!);
    const operation = match[2];
    if (!operation && request.method === "GET") return this.getRetro(retroId);
    if (operation === "join" && request.method === "POST") return this.join(retroId, principal, request);
    if (operation === "commands" && request.method === "POST") {
      return this.postCommands(retroId, principal, request);
    }
    if (operation === "ws" && request.method === "GET") return this.openSocket(retroId, principal, url, request);
    if (operation === "export" && request.method === "GET") return await exportRetro(this.state.storage, retroId);
    throw new BackendError("NOT_FOUND", "The requested API route does not exist.");
  }

  private async createRetro(request: Request, principal: AuthPrincipal): Promise<Response> {
    const body = await parseBody(request, CreateRetroRequestSchema);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const retro = RetroSchema.parse({
      schemaVersion: RETRO_SCHEMA_VERSION,
      id,
      title: body.title,
      status: "open",
      captainId: principal.actorId,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      participants: {
        [principal.actorId]: {
          actorId: principal.actorId,
          displayName: body.displayName,
          joinedAt: now
        }
      },
      cards: {},
      reactions: {},
      lifecycleAudit: []
    });
    await this.state.storage.transaction(async (transaction) => {
      await consumeRetroCreationBudget(transaction, principal.actorId, Date.now());
      await writeRetro(transaction, retro, true);
    });
    return apiSuccess({
      retro,
      summary: RetroSummarySchema.parse({
        id,
        title: retro.title,
        status: retro.status,
        captainId: retro.captainId,
        captainDisplayName: body.displayName,
        createdAt: retro.createdAt,
        updatedAt: retro.updatedAt,
        cardCount: 0,
        participantCount: 1,
        revision: retro.revision
      })
    });
  }

  private async listRetros(url: URL): Promise<Response> {
    const rawQuery = Object.fromEntries(url.searchParams.entries());
    const parsed = RetroListQuerySchema.safeParse(rawQuery);
    if (!parsed.success || url.searchParams.size > 3) {
      throw parsed.success
        ? new BackendError("INVALID_REQUEST", "History query parameters are invalid.")
        : zodError(parsed.error);
    }
    const { status, cursor, pageSize = LIMITS.completedHistoryPageSize } = parsed.data;
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    if (status) {
      if (decoded && (decoded.group !== "status" || decoded.status !== status)) {
        throw new BackendError("INVALID_REQUEST", "The history cursor does not match this status filter.");
      }
      const prefix = indexPrefixForStatus(status);
      const entries = await this.state.storage.list<unknown>({
        prefix,
        reverse: true,
        ...(decoded ? { startAfter: decoded.key } : {}),
        limit: pageSize + 1
      });
      return this.historyPage(
        await this.summariesFromIndex(entries),
        pageSize,
        (key) => ({ group: "status", status, key })
      );
    }
    if (decoded?.group === "status") {
      throw new BackendError("INVALID_REQUEST", "The history cursor does not match this query.");
    }

    let activeEntries: [string, ReturnType<typeof RetroSummarySchema.parse>][] = [];
    if (!decoded || decoded.group === "active") {
      const active = await this.state.storage.list<unknown>({
        prefix: "index:active:",
        reverse: true,
        ...(decoded?.group === "active" ? { startAfter: decoded.key } : {}),
        limit: pageSize + 1
      });
      activeEntries = await this.summariesFromIndex(active);
      if (activeEntries.length > pageSize) {
        return this.historyPage(activeEntries, pageSize, (key) => ({ group: "active", key }));
      }
    }
    const activeCursor = decoded?.group === "active" && activeEntries.length === 0;
    const remaining = pageSize - activeEntries.length;
    const closed = await this.state.storage.list<unknown>({
      prefix: indexPrefixForStatus("closed"),
      reverse: true,
      ...(decoded?.group === "closed" ? { startAfter: decoded.key } : {}),
      limit: Math.max(1, remaining + 1)
    });
    const closedEntries = await this.summariesFromIndex(closed);
    const includeClosed = closedEntries.slice(0, remaining);
    const results = [...activeEntries, ...includeClosed];
    const closedHasMore = closedEntries.length > remaining;
    if (closedHasMore) {
      const lastClosed = includeClosed.at(-1)?.[0];
      if (lastClosed) {
        return this.historyPage(results, pageSize, () => ({ group: "closed", key: lastClosed }));
      }
      const lastActive = activeEntries.at(-1)?.[0];
      if (lastActive) {
        return this.historyPage(results, pageSize, () => ({ group: "active", key: lastActive }));
      }
    }
    if (activeCursor) {
      // An active cursor is exhausted; only closed retros remain in this query.
      return this.historyPage(
        includeClosed,
        pageSize,
        (key) => ({ group: "closed", key }),
        closedHasMore
      );
    }
    return this.historyPage(results, pageSize, (key) => ({ group: "closed", key }), closedHasMore);
  }

  private async summariesFromIndex(
    entries: Map<string, unknown>
  ): Promise<[string, ReturnType<typeof RetroSummarySchema.parse>][]> {
    return await Promise.all([...entries.entries()].map(async ([key, value]) => {
      if (typeof value !== "string") return [key, RetroSummarySchema.parse(value)];
      const summary = await this.state.storage.get<unknown>(summaryKey(value));
      if (summary === undefined) throw new StorageError("A history index references a missing retro summary.");
      return [key, RetroSummarySchema.parse(summary)];
    }));
  }

  private historyPage(
    entries: readonly (readonly [string, ReturnType<typeof RetroSummarySchema.parse>])[],
    pageSize: number,
    cursorFor: (key: string) => CursorValue,
    explicitHasMore?: boolean
  ): Response {
    const hasMore = explicitHasMore ?? entries.length > pageSize;
    const pageEntries = entries.slice(0, pageSize);
    const lastKey = pageEntries.at(-1)?.[0];
    const data = {
      retros: pageEntries.map(([, summary]) => summary),
      ...(hasMore && lastKey ? { nextCursor: encodeCursor(cursorFor(lastKey)) } : {}),
      hasMore
    };
    return apiSuccess(data);
  }

  private async getRetro(retroId: string): Promise<Response> {
    const retro = await readRetro(this.state.storage, retroId);
    if (!retro) throw new BackendError("NOT_FOUND", "This retro does not exist.");
    return apiSuccess({ retro });
  }

  private async join(
    retroId: string,
    principal: AuthPrincipal,
    request: Request
  ): Promise<Response> {
    const body = await parseBody(request, JoinRetroRequestSchema);
    const result = await joinRetro(this.state, retroId, principal, body.displayName);
    if (result.event) this.broadcastEvents(retroId, [result.event], result.retro);
    return apiSuccess({ retroId, participant: result.participant });
  }

  private async postCommands(
    retroId: string,
    principal: AuthPrincipal,
    request: Request
  ): Promise<Response> {
    const frame = await parseBody(request, PostCommandsRequestSchema);
    const acceptedCommandIds: string[] = [];
    let resultingRevision = 0;
    let deadlineChanged = false;
    try {
      for (const command of frame.commands) {
        const execution = await executeCommand(this.state, retroId, principal, command);
        deadlineChanged ||= eventsChangeScheduledDeadline(execution.events);
        if (execution.events.length) {
          this.broadcastEvents(retroId, execution.events, execution.retro);
        }
        acceptedCommandIds.push(command.commandId);
        resultingRevision = execution.ack.resultingRevision;
      }
    } finally {
      if (deadlineChanged) await this.scheduleNextAlarm();
    }
    return apiSuccess({ acceptedCommandIds, resultingRevision });
  }

  private async openSocket(
    retroId: string,
    principal: AuthPrincipal,
    url: URL,
    request: Request
  ): Promise<Response> {
    if (url.searchParams.size > 1) {
      throw new BackendError("INVALID_REQUEST", "WebSocket query parameters are invalid.");
    }
    const query = WebSocketHandshakeQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!query.success) throw zodError(query.error);
    if (query.data.protocolVersion !== PROTOCOL_VERSION) {
      throw new BackendError("UNSUPPORTED_PROTOCOL", "This WebSocket protocol version is not supported.");
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new BackendError("INVALID_REQUEST", "A WebSocket upgrade is required.");
    }
    const now = Date.now();
    const tokenExpiresAt = Date.parse(principal.expiresAt);
    const expiresAt = Math.min(tokenExpiresAt, now + LIMITS.socketMaximumLifetimeMs);
    if (expiresAt <= now) throw new BackendError("AUTH_EXPIRED", "The authenticated session has expired.");

    const retro = await readRetro(this.state.storage, retroId);
    if (!retro) throw new BackendError("NOT_FOUND", "This retro does not exist.");
    if (retro.status === "closed") throw new BackendError("CONFLICT", "Completed retros do not accept live sockets.");
    if (!retro.participants[principal.actorId]) {
      throw new BackendError("FORBIDDEN", "Join this retro before opening a live connection.");
    }

    const sockets = this.state.getWebSockets();
    for (const socket of sockets) this.closeIfInvalidOrExpired(socket, now);
    const liveSockets = this.state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
    if (liveSockets.length >= LIMITS.socketsPerDeployment) {
      throw new BackendError("RATE_LIMITED", "The deployment has reached its live connection limit.");
    }
    const actorSockets = this.state.getWebSockets(`retro:${retroId}`)
      .filter((socket) => {
        const attachment = deserializeSocketAttachment(socket);
        return socket.readyState === WebSocket.OPEN && attachment?.actorId === principal.actorId;
      });
    if (actorSockets.length >= LIMITS.socketsPerActorPerRetro) {
      throw new BackendError("RATE_LIMITED", "This identity already has the maximum number of live tabs.");
    }
    const alreadyConnected = actorSockets.length > 0;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const attachment = SocketAttachmentSchema.parse({
      actorId: principal.actorId,
      retroId,
      clientId: crypto.randomUUID(),
      expiresAt: new Date(expiresAt).toISOString(),
      warningSent: false,
      isAdministrator: principal.isAdministrator
    });
    this.state.acceptWebSocket(server, [`retro:${retroId}`]);
    writeSocketAttachment(server, attachment);

    const snapshot = SnapshotMessageSchema.parse({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      retro,
      serverTime: new Date().toISOString(),
      clientId: attachment.clientId
    });
    this.sendToSocket(server, snapshot, now);
    const warningAt = expiresAt - 5 * 60_000;
    if (warningAt <= now) {
      this.sendToSocket(server, {
        type: "auth.expiring",
        protocolVersion: PROTOCOL_VERSION,
        expiresAt: attachment.expiresAt,
        warningAt: new Date(Math.min(warningAt, expiresAt)).toISOString()
      }, now);
      attachment.warningSent = true;
      writeSocketAttachment(server, attachment);
    }
    await this.sendLivePresenceSnapshot(server, retro);
    if (!alreadyConnected) await this.broadcastActorPresence(retroId, principal.actorId, retro);
    await this.scheduleNextAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    const attachment = deserializeSocketAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Invalid connection state");
      return;
    }
    if (Date.parse(attachment.expiresAt) <= now) {
      socket.close(AUTH_REQUIRED_CLOSE_CODE, "Authentication required");
      return;
    }
    if (bytesOfFrame(rawMessage) > LIMITS.incomingWebSocketFrameBytes) {
      socket.close(1009, "Frame too large");
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(messageToText(rawMessage));
    } catch {
      this.sendResyncRequired(socket, "state-unknown");
      return;
    }
    let frame;
    try {
      frame = parseClientFrame(decoded);
    } catch {
      this.sendResyncRequired(socket, "state-unknown");
      return;
    }
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      this.sendResyncRequired(socket, "state-unknown");
      return;
    }
    if ("type" in frame) {
      await this.broadcastGiphyShare(attachment, frame);
      return;
    }
    const principal = this.principalFromAttachment(attachment);
    let deadlineChanged = false;
    try {
      for (const command of frame.commands) {
        const liveAttachment = deserializeSocketAttachment(socket);
        if (!liveAttachment || Date.parse(liveAttachment.expiresAt) <= Date.now()) {
          socket.close(AUTH_REQUIRED_CLOSE_CODE, "Authentication required");
          return;
        }
        try {
          if (command.type === "presence.editing") {
            await this.handleEditingPresence(socket, liveAttachment, command);
            continue;
          }
          const result = await executeCommand(
            this.state,
            liveAttachment.retroId,
            principal,
            command,
            liveAttachment.clientId
          );
          deadlineChanged ||= eventsChangeScheduledDeadline(result.events);
          if (result.events.length) {
            this.broadcastEvents(liveAttachment.retroId, result.events, result.retro);
          }
          this.sendToSocket(socket, result.ack, Date.now());
        } catch (error) {
          this.sendCommandError(socket, liveAttachment.retroId, command.commandId, backendError(error));
        }
      }
    } finally {
      if (deadlineChanged) await this.scheduleNextAlarm();
    }
  }

  private async broadcastGiphyShare(attachment: SocketAttachment, request: GiphyShareRequest): Promise<void> {
    const retro = await readRetro(this.state.storage, attachment.retroId).catch(() => undefined);
    if (!retro || retro.status !== "open" || !retro.participants[attachment.actorId]) return;
    this.broadcastToRetro(attachment.retroId, GiphySharedMessageSchema.parse({
      type: "giphy.shared",
      protocolVersion: PROTOCOL_VERSION,
      retroId: attachment.retroId,
      shareId: crypto.randomUUID(),
      media: request.media
    }));
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = deserializeSocketAttachment(socket);
    if (!attachment) return;
    const retro = await readRetro(this.state.storage, attachment.retroId).catch(() => undefined);
    if (retro && retro.status !== "closed") {
      await this.broadcastActorPresence(attachment.retroId, attachment.actorId, retro, socket);
    }
    await this.scheduleNextAlarm();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = deserializeSocketAttachment(socket);
    try {
      socket.close(1011, "Connection error");
    } catch {
      // Closing a failed socket is best effort.
    }
    if (attachment) {
      const retro = await readRetro(this.state.storage, attachment.retroId).catch(() => undefined);
      if (retro && retro.status !== "closed") {
        await this.broadcastActorPresence(attachment.retroId, attachment.actorId, retro, socket);
      }
    }
    await this.scheduleNextAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const disconnectedActors = new Map<string, Set<string>>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = deserializeSocketAttachment(socket);
      if (!attachment) {
        try {
          socket.close(1011, "Invalid connection state");
        } catch {
          // The socket may already be closed.
        }
        continue;
      }
      const expiresAt = Date.parse(attachment.expiresAt);
      if (expiresAt <= now) {
        try {
          socket.close(AUTH_REQUIRED_CLOSE_CODE, "Authentication required");
        } catch {
          // The runtime may have closed the socket concurrently.
        }
        const actorIds = disconnectedActors.get(attachment.retroId) ?? new Set<string>();
        actorIds.add(attachment.actorId);
        disconnectedActors.set(attachment.retroId, actorIds);
      } else if (!attachment.warningSent && expiresAt - 5 * 60_000 <= now) {
        const warningAt = new Date(expiresAt - 5 * 60_000).toISOString();
        this.sendToSocket(socket, {
          type: "auth.expiring",
          protocolVersion: PROTOCOL_VERSION,
          expiresAt: attachment.expiresAt,
          warningAt
        }, now);
        attachment.warningSent = true;
        writeSocketAttachment(socket, attachment);
      }
    }
    for (const [retroId, actorIds] of disconnectedActors) {
      const retro = await readRetro(this.state.storage, retroId).catch(() => undefined);
      if (!retro) continue;
      for (const actorId of actorIds) {
        await this.broadcastActorPresence(retroId, actorId, retro);
      }
    }

    let processedDeadlines = 0;
    while (processedDeadlines < ALARM_DEADLINE_BATCH) {
      const [deadlineEntry] = (await this.state.storage.list<{ retroId: string; generation: string }>({
        prefix: "deadline:",
        limit: 1
      })).entries();
      if (!deadlineEntry) break;
      const [key, value] = deadlineEntry;
      const deadline = key.slice("deadline:".length, -(value.retroId.length + 1));
      const retroId = value.retroId;
      if (!deadline || !retroId || Date.parse(deadline) > now) break;
      const result = await markClosingDeadlineReached(
        this.state,
        value.retroId,
        value.generation,
        deadline
      );
      if (result.event && result.retro) {
        this.broadcastEvents(value.retroId, [result.event], result.retro);
      }
      processedDeadlines += 1;
    }
    await this.scheduleNextAlarm(processedDeadlines >= ALARM_DEADLINE_BATCH);
  }

  private principalFromAttachment(attachment: SocketAttachment): AuthPrincipal {
    // The attachment is server-created and schema-validated. Command handlers re-read
    // current retro state and enforce membership/permissions before every operation.
    return AuthPrincipalSchema.parse({
      actorId: attachment.actorId,
      subject: "socket-verified-principal",
      email: "socket@internal.invalid",
      emailDomain: "internal.invalid",
      issuer: "socket://verified",
      expiresAt: attachment.expiresAt,
      isAdministrator: attachment.isAdministrator,
      authMethod: "cloudflare-access"
    });
  }

  private async handleEditingPresence(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: Extract<ClientCommand, { type: "presence.editing" }>
  ): Promise<void> {
    const retro = await readRetro(this.state.storage, attachment.retroId);
    if (!retro) throw new BackendError("NOT_FOUND", "This retro does not exist.");
    const now = Date.now();
    if (
      command.payload.editing &&
      attachment.lastPresenceCommandAt &&
      now - Date.parse(attachment.lastPresenceCommandAt) < 250
    ) {
      this.sendToSocket(socket, this.presenceAck(attachment, command, retro.revision, "noop"), now);
      return;
    }
    if (!retro.participants[attachment.actorId]) {
      throw new BackendError("FORBIDDEN", "Join this retro before editing.");
    }
    const priorCardId = attachment.editingCardId;
    if (command.payload.editing) {
      const card = retro.cards[command.payload.cardId];
      if (!card || card.authorId !== attachment.actorId) {
        throw new BackendError("FORBIDDEN", "Only the card author can edit this card.");
      }
      if (retro.status === "closing") {
        if (!retro.closing?.requiredClients.some((client) =>
          client.clientId === attachment.clientId && client.actorId === attachment.actorId
        )) {
          throw new BackendError("FORBIDDEN", "This connection was not captured for finishing.");
        }
        if (retro.closing.readyClients.some((client) => client.clientId === attachment.clientId)) {
          throw new BackendError("CONFLICT", "This connection has already reported that it is ready.");
        }
      } else if (retro.status !== "open") {
        throw new BackendError("CONFLICT", "This retro is read-only.");
      }
      if (
        priorCardId === command.payload.cardId &&
        attachment.editingUpdatedAt &&
        now - Date.parse(attachment.editingUpdatedAt) < LIMITS.editingPresenceRefreshMs
      ) {
        this.sendToSocket(socket, this.presenceAck(attachment, command, retro.revision, "noop"), now);
        return;
      }
      attachment.editingCardId = command.payload.cardId;
      attachment.editingUpdatedAt = new Date(now).toISOString();
    } else {
      if (priorCardId !== command.payload.cardId) {
        this.sendToSocket(socket, this.presenceAck(attachment, command, retro.revision, "noop"), Date.now());
        return;
      }
      delete attachment.editingCardId;
      delete attachment.editingUpdatedAt;
    }
    attachment.lastPresenceCommandAt = new Date(now).toISOString();
    writeSocketAttachment(socket, attachment);
    await this.broadcastActorPresence(attachment.retroId, attachment.actorId, retro);
    this.sendToSocket(socket, this.presenceAck(attachment, command, retro.revision, "applied"), now);
  }

  private presenceAck(
    attachment: SocketAttachment,
    command: Extract<ClientCommand, { type: "presence.editing" }>,
    revision: number,
    outcome: "applied" | "noop"
  ) {
    return AckMessageSchema.parse({
      type: "ack",
      protocolVersion: PROTOCOL_VERSION,
      retroId: attachment.retroId,
      commandId: command.commandId,
      resultingRevision: revision,
      outcome,
      duplicate: false,
      processedAt: new Date().toISOString()
    });
  }

  private sendCommandError(
    socket: WebSocket,
    retroId: string,
    commandId: string,
    error: BackendError
  ): void {
    const message = CommandErrorMessageSchema.parse({
      type: "command.error",
      protocolVersion: PROTOCOL_VERSION,
      retroId,
      commandId,
      error: createApiError(error.code, error.message, crypto.randomUUID(), error.details)
    });
    this.sendToSocket(socket, message, Date.now());
  }

  private sendResyncRequired(socket: WebSocket, reason: "revision-gap" | "server-restart" | "state-unknown"): void {
    const attachment = deserializeSocketAttachment(socket);
    if (!attachment) return;
    this.sendToSocket(socket, {
      type: "resync.required",
      protocolVersion: PROTOCOL_VERSION,
      reason
    }, Date.now());
  }

  private sendToSocket(socket: WebSocket, message: unknown, now: number): boolean {
    const attachment = deserializeSocketAttachment(socket);
    if (!attachment || Date.parse(attachment.expiresAt) <= now) {
      try {
        socket.close(AUTH_REQUIRED_CLOSE_CODE, "Authentication required");
      } catch {
        // Best-effort auth expiry close.
      }
      return false;
    }
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      try {
        socket.close(1013, "Client is too slow; reconnect to resynchronize");
      } catch {
        // The socket may have already closed.
      }
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      try {
        socket.close(1011, "Unable to send data");
      } catch {
        // Best effort.
      }
      return false;
    }
  }

  private closeIfInvalidOrExpired(socket: WebSocket, now: number): void {
    const attachment = deserializeSocketAttachment(socket);
    if (!attachment) {
      try {
        socket.close(1011, "Invalid connection state");
      } catch {
        // Best effort.
      }
    } else if (Date.parse(attachment.expiresAt) <= now) {
      try {
        socket.close(AUTH_REQUIRED_CLOSE_CODE, "Authentication required");
      } catch {
        // Best effort.
      }
    }
  }

  private broadcastEvents(
    retroId: string,
    events: PersistedBoardEvent[],
    retro: Retro
  ): void {
    if (!events.length) return;
    const message = EventsMessageSchema.parse({
      type: "events",
      protocolVersion: PROTOCOL_VERSION,
      retroId,
      events
    });
    this.broadcastToRetro(retroId, message);
    for (const event of events) {
      if (event.type === "retro.closing.started") {
        this.broadcastToRetro(retroId, FinishRequestedMessageSchema.parse({
          type: "finish.requested",
          protocolVersion: PROTOCOL_VERSION,
          retroId,
          closing: event.closing
        }));
      }
      if (isFinishProgressEvent(event) && retro.closing) {
        this.broadcastFinishProgress(retroId, retro);
      }
      if (event.type === "retro.closing.deadline-reached") {
        this.broadcastFinishProgress(retroId, retro);
      }
      if (event.type === "retro.closed") {
        this.broadcastToRetro(retroId, RetroClosedMessageSchema.parse({
          type: "retro.closed",
          protocolVersion: PROTOCOL_VERSION,
          retroId,
          event
        }));
        for (const socket of this.state.getWebSockets(`retro:${retroId}`)) {
          try {
            socket.close(1000, "Retro completed");
          } catch {
            // A participant may already have disconnected.
          }
        }
      }
    }
  }

  private broadcastFinishProgress(retroId: string, retro: Retro): void {
    const closing = retro.closing;
    if (!closing) return;
    const readyIds = new Set(closing.readyClients.map((client) => client.clientId));
    const message = FinishProgressMessageSchema.parse({
      type: "finish.progress",
      protocolVersion: PROTOCOL_VERSION,
      retroId,
      generation: closing.generation,
      readyCount: closing.readyClients.length,
      requiredCount: closing.requiredClients.length,
      missingClients: closing.requiredClients.filter((client) => !readyIds.has(client.clientId))
    });
    this.broadcastToRetro(retroId, message);
  }

  private broadcastToRetro(retroId: string, message: unknown): void {
    const now = Date.now();
    for (const socket of this.state.getWebSockets(`retro:${retroId}`)) {
      this.sendToSocket(socket, message, now);
    }
  }

  private async broadcastActorPresence(
    retroId: string,
    actorId: string,
    retro: Retro,
    excludedSocket?: WebSocket
  ): Promise<void> {
    const message = this.presenceMessageForActor(retroId, actorId, retro, excludedSocket);
    if (message) this.broadcastToRetro(retroId, message);
  }

  private async sendLivePresenceSnapshot(socket: WebSocket, retro: Retro): Promise<void> {
    const attachments = this.state.getWebSockets(`retro:${retro.id}`)
      .map((candidate) => deserializeSocketAttachment(candidate))
      .filter((attachment): attachment is SocketAttachment =>
        Boolean(attachment && Date.parse(attachment.expiresAt) > Date.now())
      );
    const actorIds = [...new Set(attachments.map((attachment) => attachment.actorId))];
    for (const actorId of actorIds) {
      const message = this.presenceMessageForActor(retro.id, actorId, retro);
      if (message) this.sendToSocket(socket, message, Date.now());
    }
  }

  private presenceMessageForActor(
    retroId: string,
    actorId: string,
    retro: Retro,
    excludedSocket?: WebSocket
  ) {
    const now = Date.now();
    const live = this.state.getWebSockets(`retro:${retroId}`)
      .filter((socket) => socket !== excludedSocket && socket.readyState === WebSocket.OPEN)
      .map((socket) => ({ socket, attachment: deserializeSocketAttachment(socket) }))
      .filter((entry): entry is { socket: WebSocket; attachment: SocketAttachment } =>
        Boolean(entry.attachment && Date.parse(entry.attachment.expiresAt) > now)
      )
      .filter((entry) => entry.attachment.actorId === actorId);
    const participantName = actorDisplayName(retro, actorId);
    if (!participantName) return undefined;
    const editing = live
      .filter(({ attachment }) =>
        attachment.editingCardId &&
        attachment.editingUpdatedAt &&
        now - Date.parse(attachment.editingUpdatedAt) <= LIMITS.editingPresenceLeaseMs
      )
      .sort((left, right) =>
        (right.attachment.editingUpdatedAt ?? "").localeCompare(left.attachment.editingUpdatedAt ?? "")
      )[0];
    const selected = editing ?? live.sort((left, right) => left.attachment.clientId.localeCompare(right.attachment.clientId))[0];
    const departedAttachment = excludedSocket
      ? deserializeSocketAttachment(excludedSocket)
      : undefined;
    return PresenceMessageSchema.parse({
      type: "presence",
      protocolVersion: PROTOCOL_VERSION,
      retroId,
      clientId: selected?.attachment.clientId ?? departedAttachment?.clientId ?? crypto.randomUUID(),
      actorId,
      displayName: participantName,
      connected: live.length > 0,
      cardId: editing?.attachment.editingCardId ?? null,
      editing: Boolean(editing),
      updatedAt: new Date(now).toISOString()
    });
  }

  private async scheduleNextAlarm(forceShortRetry = false): Promise<void> {
    const now = Date.now();
    let next: number | undefined;
    for (const socket of this.state.getWebSockets()) {
      const attachment = deserializeSocketAttachment(socket);
      if (!attachment) continue;
      const expiresAt = Date.parse(attachment.expiresAt);
      if (expiresAt > now) next = next === undefined ? expiresAt : Math.min(next, expiresAt);
      const warningAt = expiresAt - 5 * 60_000;
      if (!attachment.warningSent && warningAt > now) {
        next = next === undefined ? warningAt : Math.min(next, warningAt);
      }
    }
    const [deadlineEntry] = (await this.state.storage.list<{ retroId: string; generation: string }>({
      prefix: "deadline:",
      limit: 1
    })).entries();
    if (deadlineEntry) {
      const deadlineKey = deadlineEntry[0];
      const deadlineText = deadlineKey.slice(
        "deadline:".length,
        -(deadlineEntry[1].retroId.length + 1)
      );
      const deadline = Date.parse(deadlineText);
      if (deadline > now) next = next === undefined ? deadline : Math.min(next, deadline);
      else if (forceShortRetry) next = now + 1_000;
      else next = next === undefined ? now + 1_000 : Math.min(next, now + 1_000);
    }
    if (forceShortRetry) next = next === undefined ? now + 1_000 : Math.min(next, now + 1_000);
    if (next === undefined) {
      await this.state.storage.deleteAlarm();
    } else {
      await this.state.storage.setAlarm(Math.max(now + 1, next));
    }
  }
}
