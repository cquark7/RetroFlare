import { LIMITS, PROTOCOL_VERSION } from "../src/shared/constants";
import { ParticipantSchema, RetroSchema, compareCardsInColumnOrder } from "../src/shared/domain";
import type { ClosingClient, Participant, Retro } from "../src/shared/domain";
import { PersistedBoardEventSchema } from "../src/shared/events";
import type { PersistedBoardEvent } from "../src/shared/events";
import { AckMessageSchema } from "../src/shared/protocol";
import type { AuthPrincipal } from "../src/shared/auth";
import type { ClientCommand } from "../src/shared/protocol";
import { reduceRetroEvent } from "../src/shared/reducer";
import { BackendError } from "./http";
import {
  closingDeadlineKey,
  consumeActorMutationBudget,
  operationsKey,
  readRetro,
  writeRetro
} from "./storage";
import { deserializeSocketAttachment } from "./socket-types";

type Ack = ReturnType<typeof AckMessageSchema.parse>;
type StoredOperation = {
  commandId: string;
  actorId: string;
  fingerprint: string;
  resultingRevision: number;
  outcome: "applied" | "noop";
  processedAt: string;
  entity?: { kind: "card"; id: string; version: number };
};

export type CommandExecution = {
  retro: Retro;
  ack: Ack;
  events: PersistedBoardEvent[];
};

type ApplyResult = {
  retro: Retro;
  events: PersistedBoardEvent[];
  entity?: { kind: "card"; id: string; version: number };
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkRetroBytes(retro: Retro): Retro {
  const parsed = RetroSchema.parse(retro);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > LIMITS.serializedRetroBytes) {
    throw new BackendError("PAYLOAD_TOO_LARGE", "The retro is too large to save.");
  }
  return parsed;
}

function appendEvent(
  retro: Retro,
  payload: Record<string, unknown>
): { retro: Retro; event: PersistedBoardEvent } {
  const event = PersistedBoardEventSchema.parse({
    ...payload,
    retroId: retro.id,
    revision: retro.revision + 1,
    occurredAt: new Date().toISOString()
  });
  const reduction = reduceRetroEvent(retro, event);
  if (reduction.status !== "applied") {
    throw new BackendError("INTERNAL_ERROR", "The retro event could not be applied safely.");
  }
  return { retro: checkRetroBytes(reduction.retro), event };
}

function requireJoined(retro: Retro, actorId: string): Participant {
  const participant = retro.participants[actorId];
  if (!participant) throw new BackendError("FORBIDDEN", "Join this retro before changing it.");
  return participant;
}

function requireOpen(retro: Retro): void {
  if (retro.status !== "open") throw new BackendError("CONFLICT", "This retro is not open.");
}

function requireCaptain(retro: Retro, actorId: string): void {
  if (retro.captainId !== actorId) throw new BackendError("FORBIDDEN", "Only the current captain can do this.");
}

function checkExpectedRevision(retro: Retro, expected: number): void {
  if (retro.revision !== expected) {
    throw new BackendError("CONFLICT", "The retro changed before this action was applied.", {
      currentRevision: retro.revision
    });
  }
}

function closingClient(
  retro: Retro,
  actorId: string,
  clientId: string | undefined,
  requirePending: boolean
): ClosingClient {
  if (retro.status !== "closing" || !retro.closing || !clientId) {
    throw new BackendError("CONFLICT", "This edit is not part of the active finish attempt.");
  }
  const client = retro.closing.requiredClients.find(
    (candidate) => candidate.clientId === clientId && candidate.actorId === actorId
  );
  if (!client) throw new BackendError("FORBIDDEN", "This connection was not captured for finishing.");
  if (requirePending && retro.closing.readyClients.some((ready) => ready.clientId === clientId)) {
    throw new BackendError("CONFLICT", "This connection has already reported that it is ready.");
  }
  return client;
}

function currentCardVersionError(version: number, retro: Retro): BackendError {
  return new BackendError("CONFLICT", "This card changed before your edit was applied.", {
    currentCardVersion: version,
    currentRevision: retro.revision
  });
}

function verifyCardVersion(cardVersion: number, expected: number, retro: Retro): void {
  if (cardVersion !== expected) throw currentCardVersionError(cardVersion, retro);
}

function applyCommand(
  initialRetro: Retro,
  command: ClientCommand,
  principal: AuthPrincipal,
  clientId: string | undefined,
  requiredClients: ClosingClient[]
): ApplyResult {
  let retro = initialRetro;
  const events: PersistedBoardEvent[] = [];
  const push = (payload: Record<string, unknown>): void => {
    const result = appendEvent(retro, payload);
    retro = result.retro;
    events.push(result.event);
  };
  const actorId = principal.actorId;
  const participant = retro.participants[actorId];

  switch (command.type) {
    case "card.create": {
      if (!participant) throw new BackendError("FORBIDDEN", "Join this retro before adding a card.");
      requireOpen(retro);
      const payload = command.payload;
      const existing = retro.cards[payload.cardId];
      if (existing) {
        if (
          existing.authorId === actorId &&
          existing.columnId === payload.columnId &&
          existing.text === payload.text &&
          existing.actionOwnerName === payload.actionOwnerName
        ) {
          return { retro, events, entity: { kind: "card", id: existing.id, version: existing.version } };
        }
        throw new BackendError("CONFLICT", "That card ID is already in use.");
      }
      if (Object.keys(retro.cards).length >= LIMITS.cardsPerRetro) {
        throw new BackendError("CONFLICT", "This retro already has the maximum number of cards.");
      }
      const now = new Date().toISOString();
      const card = {
        id: payload.cardId,
        columnId: payload.columnId,
        text: payload.text,
        authorId: actorId,
        authorDisplayName: participant.displayName,
        ...(payload.actionOwnerName ? { actionOwnerName: payload.actionOwnerName } : {}),
        version: 1,
        createdAt: now,
        updatedAt: now
      };
      push({ type: "card.created", card });
      return { retro, events, entity: { kind: "card", id: card.id, version: card.version } };
    }
    case "card.update": {
      if (!participant) throw new BackendError("FORBIDDEN", "Join this retro before editing a card.");
      const card = retro.cards[command.payload.cardId];
      if (!card) throw new BackendError("NOT_FOUND", "That card no longer exists.");
      if (retro.status === "closing") closingClient(retro, actorId, clientId, true);
      else requireOpen(retro);
      if (card.authorId !== actorId) throw new BackendError("FORBIDDEN", "Only the card author can edit its text.");
      const ownerName = command.payload.actionOwnerName === undefined
        ? card.actionOwnerName
        : command.payload.actionOwnerName ?? undefined;
      if (ownerName && card.columnId !== "actions") {
        throw new BackendError("INVALID_REQUEST", "Only action cards can have an owner.");
      }
      if (card.text === command.payload.text && card.actionOwnerName === ownerName) {
        return { retro, events, entity: { kind: "card", id: card.id, version: card.version } };
      }
      verifyCardVersion(card.version, command.payload.expectedCardVersion, retro);
      const nextVersion = card.version + 1;
      push({
        type: "card.updated",
        cardId: card.id,
        text: command.payload.text,
        actionOwnerName: ownerName ?? null,
        version: nextVersion,
        updatedAt: new Date().toISOString()
      });
      return { retro, events, entity: { kind: "card", id: card.id, version: nextVersion } };
    }
    case "card.delete": {
      if (!participant) throw new BackendError("FORBIDDEN", "Join this retro before deleting a card.");
      requireOpen(retro);
      const card = retro.cards[command.payload.cardId];
      if (!card) return { retro, events };
      if (card.authorId !== actorId) throw new BackendError("FORBIDDEN", "Only the card author can delete it.");
      verifyCardVersion(card.version, command.payload.expectedCardVersion, retro);
      push({ type: "card.deleted", cardId: card.id, deletedVersion: card.version });
      return { retro, events };
    }
    case "card.move": {
      if (!participant) throw new BackendError("FORBIDDEN", "Join this retro before moving a card.");
      requireOpen(retro);
      const card = retro.cards[command.payload.cardId];
      if (!card) throw new BackendError("NOT_FOUND", "That card no longer exists.");
      if (card.authorId !== actorId && retro.captainId !== actorId) {
        throw new BackendError("FORBIDDEN", "Only the card author or captain can move it.");
      }
      if (card.columnId === command.payload.columnId) {
        return { retro, events, entity: { kind: "card", id: card.id, version: card.version } };
      }
      verifyCardVersion(card.version, command.payload.expectedCardVersion, retro);
      if (card.columnId === "actions" || command.payload.columnId === "actions") {
        throw new BackendError("CONFLICT", "Action items are added separately and cannot be moved between reflection columns.");
      }
      const nextVersion = (retro.cards[card.id]?.version ?? card.version) + 1;
      const currentCard = retro.cards[card.id] ?? card;
      push({
        type: "card.moved",
        cardId: currentCard.id,
        fromColumnId: currentCard.columnId,
        columnId: command.payload.columnId,
        actionOwnerName: null,
        version: nextVersion,
        updatedAt: new Date().toISOString()
      });
      return { retro, events, entity: { kind: "card", id: card.id, version: nextVersion } };
    }
    case "card.reorder": {
      if (!participant) throw new BackendError("FORBIDDEN", "Join this retro before reordering cards.");
      requireOpen(retro);
      const { cardId, columnId, orderedCardIds, expectedRetroRevision } = command.payload;
      const card = retro.cards[cardId];
      if (!card) throw new BackendError("NOT_FOUND", "That card no longer exists.");
      if (card.columnId !== columnId) {
        throw new BackendError("CONFLICT", "That card is no longer in this column.");
      }
      if (card.authorId !== actorId && retro.captainId !== actorId) {
        throw new BackendError("FORBIDDEN", "Only the card author or captain can reorder it.");
      }
      checkExpectedRevision(retro, expectedRetroRevision);
      const currentOrder = Object.values(retro.cards)
        .filter((candidate) => candidate.columnId === columnId)
        .sort(compareCardsInColumnOrder)
        .map((candidate) => candidate.id);
      const requestedIds = new Set(orderedCardIds);
      if (
        orderedCardIds.length !== currentOrder.length ||
        requestedIds.size !== currentOrder.length ||
        currentOrder.some((currentId) => !requestedIds.has(currentId))
      ) {
        throw new BackendError("CONFLICT", "The cards in this column changed. Refresh the board and try again.");
      }
      if (currentOrder.every((currentId, index) => currentId === orderedCardIds[index])) {
        return { retro, events };
      }
      const currentWithoutMovedCard = currentOrder.filter((currentId) => currentId !== cardId);
      const requestedWithoutMovedCard = orderedCardIds.filter((currentId) => currentId !== cardId);
      if (currentWithoutMovedCard.some((currentId, index) => currentId !== requestedWithoutMovedCard[index])) {
        throw new BackendError("INVALID_REQUEST", "A reorder can only change the dragged card's position.");
      }
      push({ type: "card.reordered", cardId, columnId, orderedCardIds });
      return { retro, events };
    }
    case "reaction.set": {
      requireJoined(retro, actorId);
      requireOpen(retro);
      const card = retro.cards[command.payload.cardId];
      if (!card) throw new BackendError("NOT_FOUND", "That card no longer exists.");
      const { emoji, reacted } = command.payload;
      const matches = (entry: { cardId: string; emoji: string }) => entry.cardId === card.id && entry.emoji === emoji;
      if ((retro.reactions[actorId] ?? []).some(matches) === reacted) return { retro, events };
      const count = Object.values(retro.reactions).filter((entries) => entries.some(matches)).length;
      push({
        type: "reaction.changed",
        actorId,
        cardId: card.id,
        emoji,
        reacted,
        reactionCount: count + (reacted ? 1 : -1)
      });
      return { retro, events };
    }
    case "captain.transfer": {
      requireCaptain(retro, actorId);
      requireOpen(retro);
      checkExpectedRevision(retro, command.payload.expectedRetroRevision);
      if (!retro.participants[command.payload.nextCaptainId]) {
        throw new BackendError("CONFLICT", "The next captain must have joined this retro.");
      }
      if (command.payload.nextCaptainId === retro.captainId) return { retro, events };
      const audit = {
        type: "captain.transferred" as const,
        occurredAt: new Date().toISOString(),
        actorId,
        previousCaptainId: retro.captainId,
        newCaptainId: command.payload.nextCaptainId
      };
      push({ type: "captain.transferred", captainId: command.payload.nextCaptainId, audit });
      return { retro, events };
    }
    case "captain.recover": {
      if (!principal.isAdministrator) throw new BackendError("FORBIDDEN", "Only a configured administrator can recover captain responsibility.");
      if (retro.status === "closed") throw new BackendError("CONFLICT", "A completed retro cannot change captain.");
      checkExpectedRevision(retro, command.payload.expectedRetroRevision);
      if (!retro.participants[command.payload.newCaptainId]) {
        throw new BackendError("CONFLICT", "The recovered captain must have joined this retro.");
      }
      if (command.payload.newCaptainId === retro.captainId) return { retro, events };
      const audit = {
        type: "captain.recovered" as const,
        occurredAt: new Date().toISOString(),
        administratorId: actorId,
        previousCaptainId: retro.captainId,
        recoveredCaptainId: command.payload.newCaptainId,
        ...(command.payload.reason ? { reason: command.payload.reason } : {})
      };
      push({ type: "captain.recovered", captainId: command.payload.newCaptainId, audit });
      return { retro, events };
    }
    case "retro.prepareFinish": {
      requireCaptain(retro, actorId);
      if (retro.status !== "open") throw new BackendError("CONFLICT", "This retro is not open.");
      checkExpectedRevision(retro, command.payload.expectedRetroRevision);
      const now = Date.now();
      const requestedAt = new Date(now).toISOString();
      const deadline = new Date(now + LIMITS.closingWindowMs).toISOString();
      const closing = {
        generation: crypto.randomUUID(),
        requestedBy: actorId,
        requestedAt,
        deadline,
        deadlineReached: false,
        requiredClients,
        readyClients: []
      };
      push({ type: "retro.closing.started", closing });
      return { retro, events };
    }
    case "retro.finishReady": {
      const captured = closingClient(retro, actorId, clientId, false);
      if (retro.closing!.generation !== command.payload.generation) {
        throw new BackendError("CONFLICT", "This finish attempt is no longer active.");
      }
      if (retro.closing!.readyClients.some((client) => client.clientId === captured.clientId)) {
        return { retro, events };
      }
      const readyClient = { ...captured, readyAt: new Date().toISOString() };
      const readyCount = retro.closing!.readyClients.length + 1;
      push({
        type: "retro.closing.ready",
        generation: command.payload.generation,
        client: readyClient,
        readyCount,
        requiredCount: retro.closing!.requiredClients.length
      });
      return { retro, events };
    }
    case "retro.finalizeFinish": {
      requireCaptain(retro, actorId);
      if (retro.status !== "closing" || !retro.closing) {
        throw new BackendError("CONFLICT", "There is no finish attempt to complete.");
      }
      if (retro.closing.generation !== command.payload.generation) {
        throw new BackendError("CONFLICT", "This finish attempt is no longer active.");
      }
      const missingClients = retro.closing.requiredClients.filter(
        (required) => !retro.closing!.readyClients.some((ready) => ready.clientId === required.clientId)
      );
      if (command.payload.forceSavedContent) {
        if (!retro.closing.deadlineReached) {
          throw new BackendError("CONFLICT", "Saved-content finishing is available only after the deadline.");
        }
      } else if (missingClients.length > 0) {
        throw new BackendError("CONFLICT", "Wait for all captured connections or explicitly finish saved content.");
      }
      const closedAt = new Date().toISOString();
      const removedEmptyCardIds = Object.values(retro.cards)
        .filter((card) => card.text.length === 0)
        .map((card) => card.id)
        .sort();
      const audit = command.payload.forceSavedContent
        ? {
            type: "retro.force-finished" as const,
            occurredAt: closedAt,
            actorId,
            generation: command.payload.generation,
            missingClientIds: missingClients.map((client) => client.clientId)
          }
        : undefined;
      push({
        type: "retro.closed",
        generation: command.payload.generation,
        closedAt,
        forcedSavedContent: command.payload.forceSavedContent ?? false,
        removedEmptyCardIds,
        ...(audit ? { audit } : {})
      });
      return { retro, events };
    }
    case "retro.cancelFinish": {
      requireCaptain(retro, actorId);
      if (retro.status !== "closing" || !retro.closing || retro.closing.generation !== command.payload.generation) {
        throw new BackendError("CONFLICT", "This finish attempt is no longer active.");
      }
      push({ type: "retro.closing.cancelled", generation: command.payload.generation });
      return { retro, events };
    }
    case "presence.editing":
      throw new BackendError("INVALID_REQUEST", "Presence commands require a live WebSocket connection.");
  }
}

function makeAck(
  retroId: string,
  commandId: string,
  resultingRevision: number,
  outcome: "applied" | "noop",
  duplicate: boolean,
  processedAt: string,
  entity?: StoredOperation["entity"]
): Ack {
  return AckMessageSchema.parse({
    type: "ack",
    protocolVersion: PROTOCOL_VERSION,
    retroId,
    commandId,
    resultingRevision,
    outcome,
    duplicate,
    ...(entity ? { entity } : {}),
    processedAt
  });
}

function requireActorForWrite(principal: AuthPrincipal): void {
  if (!principal.actorId || !principal.subject) {
    throw new BackendError("AUTH_REQUIRED", "The verified identity is unavailable.");
  }
}

export async function executeCommand(
  state: DurableObjectState,
  retroId: string,
  principal: AuthPrincipal,
  command: ClientCommand,
  clientId?: string
): Promise<CommandExecution> {
  if (command.type === "retro.prepareFinish") {
    return state.blockConcurrencyWhile(() => executePersistedCommand(state, retroId, principal, command, clientId));
  }
  return executePersistedCommand(state, retroId, principal, command, clientId);
}

async function executePersistedCommand(
  state: DurableObjectState,
  retroId: string,
  principal: AuthPrincipal,
  command: ClientCommand,
  clientId?: string
): Promise<CommandExecution> {
  requireActorForWrite(principal);
  if (command.type === "presence.editing") {
    throw new BackendError("INVALID_REQUEST", "Presence commands are handled by the WebSocket session.");
  }
  if (command.type === "retro.finishReady" && !clientId) {
    throw new BackendError("FORBIDDEN", "Finish readiness can only be reported by a captured WebSocket.");
  }

  const operationFingerprint = await fingerprint(command);
  return state.storage.transaction(async (transaction) => {
    const retro = await readRetro(transaction, retroId);
    if (!retro) throw new BackendError("NOT_FOUND", "This retro does not exist.");
    const priorOperations = (await transaction.get<StoredOperation[]>(operationsKey(retroId))) ?? [];
    const prior = priorOperations.find((entry) => entry.commandId === command.commandId);
    if (prior) {
      if (prior.actorId !== principal.actorId) {
        throw new BackendError("CONFLICT", "This command ID is already in use.");
      }
      if (prior.fingerprint !== operationFingerprint) {
        throw new BackendError("CONFLICT", "This command ID was already used for a different operation.");
      }
      const currentRetro = retro;
      return {
        retro: currentRetro,
        events: [],
        ack: makeAck(
          retroId,
          command.commandId,
          prior.resultingRevision,
          prior.outcome,
          true,
          prior.processedAt,
          prior.entity
        )
      };
    }

    if (
      command.type === "card.create" &&
      (await transaction.get<boolean>(`card-tombstone:${retroId}:${command.payload.cardId}`))
    ) {
      throw new BackendError("CONFLICT", "A deleted card ID cannot be reused.");
    }

    const now = Date.now();
    await consumeActorMutationBudget(transaction, principal.actorId, now);
    const capturedClients =
      command.type === "retro.prepareFinish" ? getCapturedClients(state, retroId, now) : [];
    const applied = applyCommand(retro, command, principal, clientId, capturedClients);
    const changed = applied.events.length > 0;
    if (changed) {
      await writeRetro(transaction, applied.retro);
      if (command.type === "card.delete") {
        await transaction.put(`card-tombstone:${retroId}:${command.payload.cardId}`, true);
      }
      if (
        command.type === "retro.prepareFinish" &&
        applied.retro.status === "closing" &&
        applied.retro.closing
      ) {
        await transaction.put(
          closingDeadlineKey(applied.retro.closing.deadline, retroId),
          { retroId, generation: applied.retro.closing.generation }
        );
      }
      if (
        (command.type === "retro.cancelFinish" || command.type === "retro.finalizeFinish") &&
        retro.closing
      ) {
        await transaction.delete(closingDeadlineKey(retro.closing.deadline, retroId));
      }
    }
    const processedAt = new Date().toISOString();
    const outcome = changed ? "applied" : "noop";
    const operation: StoredOperation = {
      commandId: command.commandId,
      actorId: principal.actorId,
      fingerprint: operationFingerprint,
      resultingRevision: applied.retro.revision,
      outcome,
      processedAt,
      ...(applied.entity ? { entity: applied.entity } : {})
    };
    priorOperations.push(operation);
    if (priorOperations.length > LIMITS.recentOperationsPerRetro) {
      priorOperations.splice(0, priorOperations.length - LIMITS.recentOperationsPerRetro);
    }
    await transaction.put(operationsKey(retroId), priorOperations);
    return {
      retro: applied.retro,
      events: applied.events,
      ack: makeAck(
        retroId,
        command.commandId,
        applied.retro.revision,
        outcome,
        false,
        processedAt,
        applied.entity
      )
    };
  });
}

function getCapturedClients(
  state: DurableObjectState,
  retroId: string,
  now: number
): ClosingClient[] {
  const clients = new Map<string, ClosingClient>();
  for (const socket of state.getWebSockets(`retro:${retroId}`)) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    const attachment = deserializeSocketAttachment(socket);
    if (!attachment || attachment.retroId !== retroId || Date.parse(attachment.expiresAt) <= now) {
      continue;
    }
    clients.set(attachment.clientId, {
      clientId: attachment.clientId,
      actorId: attachment.actorId
    });
  }
  return [...clients.values()].slice(0, LIMITS.socketsPerDeployment);
}

export async function joinRetro(
  state: DurableObjectState,
  retroId: string,
  principal: AuthPrincipal,
  displayName: string
): Promise<{ retro: Retro; participant: Participant; event?: PersistedBoardEvent }> {
  return state.storage.transaction(async (transaction) => {
    const retro = await readRetro(transaction, retroId);
    if (!retro) throw new BackendError("NOT_FOUND", "This retro does not exist.");
    const priorParticipant = retro.participants[principal.actorId];
    if (retro.status === "closed") {
      if (priorParticipant) return { retro, participant: priorParticipant };
      throw new BackendError("CONFLICT", "A completed retro is read-only.");
    }
    if (!priorParticipant && Object.keys(retro.participants).length >= LIMITS.participantsPerRetro) {
      throw new BackendError("CONFLICT", "This retro already has the maximum number of participants.");
    }
    const participant = ParticipantSchema.parse({
      actorId: principal.actorId,
      displayName,
      joinedAt: priorParticipant?.joinedAt ?? new Date().toISOString()
    });
    if (priorParticipant?.displayName === participant.displayName) {
      return { retro, participant };
    }
    await consumeActorMutationBudget(transaction, principal.actorId, Date.now());
    const event = PersistedBoardEventSchema.parse({
      type: "participant.upserted",
      retroId,
      revision: retro.revision + 1,
      occurredAt: new Date().toISOString(),
      participant
    });
    const reduction = reduceRetroEvent(retro, event);
    if (reduction.status !== "applied") {
      throw new BackendError("INTERNAL_ERROR", "The participant change could not be applied safely.");
    }
    const updated = checkRetroBytes(reduction.retro);
    await writeRetro(transaction, updated);
    return { retro: updated, participant, event };
  });
}

export async function markClosingDeadlineReached(
  state: DurableObjectState,
  retroId: string,
  generation: string,
  deadline: string
): Promise<{ retro?: Retro; event?: PersistedBoardEvent }> {
  return state.storage.transaction(async (transaction) => {
    const retro = await readRetro(transaction, retroId);
    if (
      !retro ||
      retro.status !== "closing" ||
      !retro.closing ||
      retro.closing.generation !== generation ||
      retro.closing.deadline !== deadline ||
      retro.closing.deadlineReached
    ) {
      await transaction.delete(closingDeadlineKey(deadline, retroId));
      return retro ? { retro } : {};
    }
    if (Date.parse(deadline) > Date.now()) return { retro };
    const event = PersistedBoardEventSchema.parse({
      type: "retro.closing.deadline-reached",
      retroId,
      revision: retro.revision + 1,
      occurredAt: new Date().toISOString(),
      generation,
      deadline
    });
    const reduction = reduceRetroEvent(retro, event);
    if (reduction.status !== "applied") {
      throw new BackendError("INTERNAL_ERROR", "The finish deadline could not be applied safely.");
    }
    await writeRetro(transaction, checkRetroBytes(reduction.retro));
    await transaction.delete(closingDeadlineKey(deadline, retroId));
    return { retro: reduction.retro, event };
  });
}

export function isFinishProgressEvent(event: PersistedBoardEvent): boolean {
  return event.type === "retro.closing.ready";
}
