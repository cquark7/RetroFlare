import { api, ApiRequestError, userSafeError } from "../api";
import { isBoardColumn, LIMITS, PROTOCOL_VERSION, type ColumnId } from "../../shared/constants";
import { createOpaqueId } from "../../shared/ids";
import { reduceRetroEvent } from "../../shared/reducer";
import { compareCardsInColumnOrder, type Card, type Retro } from "../../shared/domain";
import type { ClientCommand, GiphyMedia, GiphySharedMessage, ServerMessage } from "../../shared/protocol";
import type { PersistedBoardEvent } from "../../shared/events";
import { ClientCommandSchema, CommandFrameSchema } from "../../shared/protocol";
import { DraftStore, type StoredDraftRecord } from "./drafts";
import {
  AutosaveScheduler,
  type AutosaveStatus,
  type AutosaveUpdate,
  type AutosaveView
} from "./autosave";
import { RetroSocket, type SocketStatus } from "./socket";

type Progress = Extract<ServerMessage, { type: "finish.progress" }>;
type AckMessage = Extract<ServerMessage, { type: "ack" }>;
type PresenceMessage = Extract<ServerMessage, { type: "presence" }>;

export type BoardView = {
  retro: Retro;
  drafts: Record<string, AutosaveView>;
  localCards: Record<string, Card>;
  orphans: Record<string, StoredDraftRecord>;
  presence: PresenceMessage[];
  giphyShares: GiphySharedMessage[];
  socketStatus: SocketStatus;
  clientId?: string;
  progress?: Progress;
  actionError?: string;
  authExpiring: boolean;
  pendingCommands: string[];
};

type Waiter = {
  resolve: (message: AckMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BoardController {
  private retro: Retro;
  private readonly actorId: string;
  private readonly draftsStore: DraftStore;
  private readonly scheduler: AutosaveScheduler;
  private readonly listeners = new Set<() => void>();
  private readonly draftViews: Record<string, AutosaveView> = {};
  private readonly localCards: Record<string, Card> = {};
  private readonly presence = new Map<string, PresenceMessage>();
  private readonly giphyShares = new Map<string, GiphySharedMessage>();
  private readonly giphyShareTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly commandErrors: Record<string, string> = {};
  private readonly startedCreates = new Set<string>();
  private readonly readyGenerations = new Set<string>();
  private readonly finalizedGenerations = new Set<string>();
  private readonly composingCards = new Set<string>();
  private socket?: RetroSocket;
  private socketStatus: SocketStatus = "connecting";
  private clientId?: string;
  private progress?: Progress;
  private actionError?: string;
  private authExpiring = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private activeEditingCard?: string;
  private pageHideHandler = () => this.persistAllDrafts();
  private disposed = false;

  constructor(options: {
    retro: Retro;
    actorId: string;
    sessionExpiresAt: string;
  }) {
    this.retro = options.retro;
    this.actorId = options.actorId;
    this.draftsStore = new DraftStore(window.location.origin, options.actorId, options.retro.id);
    this.scheduler = new AutosaveScheduler({
      onDispatch: (update) => this.dispatchAutosave(update),
      onChange: (cardId, view) => this.onAutosaveChange(cardId, view)
    });
    this.restoreLocalDrafts();
    this.expiryTimer = setTimeout(
      () => this.warnAboutExpiry(),
      Math.max(0, Date.parse(options.sessionExpiresAt) - Date.now() - 5 * 60 * 1_000)
    );
    window.addEventListener("pagehide", this.pageHideHandler);
    if (this.retro.status !== "closed") {
      this.socket = new RetroSocket(this.retro.id, {
        onStatus: (status) => {
          this.socketStatus = status;
          if (status === "auth-required") this.authExpiring = true;
          this.notify();
        },
        onMessage: (message) => this.handleMessage(message),
        onReady: () => this.retryUnknownCommands(),
        onClosed: (retro) => {
          this.applySnapshot(retro);
          this.socket?.close();
          this.socketStatus = "offline";
          this.notify();
        }
      });
      this.socket.start();
    } else {
      this.socketStatus = "offline";
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  view(): BoardView {
    const knownCardIds = new Set([...Object.keys(this.retro.cards), ...Object.keys(this.localCards)]);
    const orphans = Object.fromEntries(
      Object.entries(this.draftsStore.listDrafts()).filter(([cardId]) => !knownCardIds.has(cardId))
    );
    return {
      retro: this.retro,
      drafts: { ...this.draftViews },
      localCards: { ...this.localCards },
      orphans,
      presence: [...this.presence.values()],
      giphyShares: [...this.giphyShares.values()],
      socketStatus: this.socketStatus,
      ...(this.clientId ? { clientId: this.clientId } : {}),
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.actionError ? { actionError: this.actionError } : {}),
      authExpiring: this.authExpiring,
      pendingCommands: this.draftsStore.pendingCommands().map((command) => command.commandId)
    };
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket?.close();
    for (const timer of this.giphyShareTimers.values()) clearTimeout(timer);
    this.giphyShareTimers.clear();
    this.giphyShares.clear();
    this.stopEditing();
    this.scheduler.dispose();
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    if (this.presenceTimer !== undefined) clearInterval(this.presenceTimer);
    window.removeEventListener("pagehide", this.pageHideHandler);
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Board connection closed."));
      }
    }
    this.waiters.clear();
  }

  clearLocalDrafts(): void {
    this.draftsStore.clear();
  }

  textFor(card: Card): string {
    return this.draftViews[card.id]?.text ?? this.draftsStore.getDraft(card.id)?.text ?? card.text;
  }

  errorFor(cardId: string): string | undefined {
    return this.commandErrors[cardId];
  }

  dismissError(): void {
    this.actionError = undefined;
    this.notify();
  }

  setError(error: unknown): void {
    this.actionError = userSafeError(error);
    this.notify();
  }

  shareGiphy(media: GiphyMedia): boolean {
    if (this.disposed || this.retro.status !== "open") return false;
    return this.socket?.sendGiphyShare(media) ?? false;
  }

  async updateDisplayName(displayName: string): Promise<void> {
    if (this.retro.status !== "open") throw new Error("Display names can’t be changed while this retro is finishing or complete.");
    await api.joinRetro(this.retro.id, displayName);
    this.retro = await api.retro(this.retro.id);
    this.notify();
  }

  editCard(cardId: string, text: string): void {
    if (this.retro.status !== "open") return;
    const schedulerView = this.scheduler.get(cardId);
    const currentText = schedulerView?.text ?? this.draftsStore.getDraft(cardId)?.text ?? this.localCards[cardId]?.text ?? this.retro.cards[cardId]?.text;
    if (currentText === text) return;
    this.beginEditing(cardId);
    if (schedulerView) {
      this.scheduler.edit(cardId, text);
      return;
    }
    const draft = this.draftsStore.getDraft(cardId);
    this.draftsStore.setDraft(cardId, text, draft?.version ?? 1);
    const local = this.localCards[cardId];
    if (local) this.localCards[cardId] = { ...local, text };
    this.notify();
  }

  compositionStart(cardId: string): void {
    this.composingCards.add(cardId);
    this.scheduler.compositionStart(cardId);
  }

  compositionEnd(cardId: string, text: string): void {
    this.composingCards.delete(cardId);
    if (this.scheduler.get(cardId)) this.scheduler.compositionEnd(cardId, text);
    else this.editCard(cardId, text);
  }

  beginEditing(cardId: string): void {
    if (this.retro.status !== "open") return;
    if (this.activeEditingCard === cardId) return;
    this.stopEditing();
    this.activeEditingCard = cardId;
    this.sendPresence(cardId, true);
    // Stay just above the server's minimum refresh interval so each heartbeat
    // refreshes the ten-second lease instead of being rejected as a no-op.
    this.presenceTimer = setInterval(() => this.sendPresence(cardId, true), LIMITS.editingPresenceRefreshMs + 500);
  }

  stopEditing(cardId?: string): void {
    if (!this.activeEditingCard || (cardId && this.activeEditingCard !== cardId)) return;
    const previous = this.activeEditingCard;
    this.activeEditingCard = undefined;
    if (this.presenceTimer !== undefined) clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
    this.sendPresence(previous, false);
  }

  addCard(columnId: ColumnId): void {
    if (this.retro.status !== "open") return;
    const cardId = createOpaqueId();
    const now = new Date().toISOString();
    const participant = this.retro.participants[this.actorId];
    if (!participant) return;
    const card: Card = {
      id: cardId,
      columnId,
      text: "",
      authorId: this.actorId,
      authorDisplayName: participant.displayName,
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.localCards[cardId] = card;
    this.commandErrors[cardId] = "Creating card…";
    const command: ClientCommand = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "card.create",
      payload: { cardId, columnId, text: "" }
    };
    this.notify();
    void this.sendCommand(command).then(() => {
      delete this.commandErrors[cardId];
      this.notify();
    }).catch((error: unknown) => {
      this.commandErrors[cardId] = userSafeError(error);
      this.notify();
    });
  }

  async retryCreate(cardId: string): Promise<void> {
    if (this.retro.status !== "open") return;
    const card = this.localCards[cardId];
    if (!card || this.startedCreates.has(cardId)) return;
    this.startedCreates.add(cardId);
    const existing = this.draftsStore.pendingCommands().find(
      (command): command is Extract<ClientCommand, { type: "card.create" }> =>
        command.type === "card.create" && command.payload.cardId === cardId
    );
    const command: ClientCommand = existing ?? {
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "card.create",
      payload: { cardId, columnId: card.columnId, text: "" }
    };
    try {
      await this.sendCommand(command);
      delete this.commandErrors[cardId];
    } catch (error) {
      this.commandErrors[cardId] = userSafeError(error);
    } finally {
      this.startedCreates.delete(cardId);
      this.notify();
    }
  }

  async deleteCard(cardId: string): Promise<void> {
    const card = this.retro.cards[cardId];
    if (!card || this.retro.status !== "open") return;
    if (!await this.scheduler.flush(cardId)) throw new Error("Save this card before deleting it.");
    const current = this.retro.cards[cardId];
    if (!current) return;
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "card.delete",
      payload: { cardId, expectedCardVersion: this.scheduler.get(cardId)?.version ?? current.version }
    });
  }

  async moveCard(cardId: string, columnId: ColumnId): Promise<void> {
    const card = this.retro.cards[cardId];
    if (!card || this.retro.status !== "open") return;
    if (!await this.scheduler.flush(cardId)) throw new Error("Save this card before moving it.");
    const current = this.retro.cards[cardId];
    if (!current || current.columnId === columnId) return;
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "card.move",
      payload: { cardId, columnId, expectedCardVersion: this.scheduler.get(cardId)?.version ?? current.version }
    });
  }

  async reorderCards(cardId: string, orderedCardIds: string[]): Promise<void> {
    const card = this.retro.cards[cardId];
    if (!card || this.retro.status !== "open" || !isBoardColumn(card.columnId)) return;
    if (!await this.scheduler.flush(cardId)) throw new Error("Save this card before reordering it.");
    const current = this.retro.cards[cardId];
    if (!current || current.columnId !== card.columnId || !isBoardColumn(current.columnId)) return;
    const currentOrder = Object.values(this.retro.cards)
      .filter((candidate) => candidate.columnId === current.columnId)
      .sort(compareCardsInColumnOrder)
      .map((candidate) => candidate.id);
    if (currentOrder.length === orderedCardIds.length && currentOrder.every((id, index) => id === orderedCardIds[index])) return;
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "card.reorder",
      payload: {
        cardId,
        columnId: current.columnId,
        orderedCardIds,
        expectedRetroRevision: this.retro.revision
      }
    });
  }

  async setActionOwner(cardId: string, owner: string): Promise<void> {
    const card = this.retro.cards[cardId];
    if (!card || card.columnId !== "actions" || card.authorId !== this.actorId || this.retro.status !== "open") return;
    if (!await this.scheduler.flush(cardId)) throw new Error("Save this card before changing its owner.");
    const current = this.retro.cards[cardId];
    if (!current) return;
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "card.update",
      payload: {
        cardId,
        text: this.textFor(current),
        actionOwnerName: owner.trim() || null,
        expectedCardVersion: this.scheduler.get(cardId)?.version ?? current.version
      }
    });
  }

  async react(cardId: string, emoji: import("../../shared/constants").ReactionEmoji, reacted: boolean): Promise<void> {
    if (this.retro.status !== "open") return;
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "reaction.set",
      payload: { cardId, emoji, reacted }
    });
  }

  async transferCaptain(nextCaptainId: string): Promise<void> {
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "captain.transfer",
      payload: { nextCaptainId, expectedRetroRevision: this.retro.revision }
    });
  }

  async recoverCaptain(newCaptainId: string, reason?: string): Promise<void> {
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "captain.recover",
      payload: {
        newCaptainId,
        expectedRetroRevision: this.retro.revision,
        ...(reason ? { reason } : {})
      }
    });
  }

  async prepareFinish(): Promise<void> {
    if (this.retro.status !== "open") return;
    if (!await this.flushAllLocal()) throw new Error("Some changes are still waiting to save. Try again when they’re synced.");
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "retro.prepareFinish",
      payload: { expectedRetroRevision: this.retro.revision }
    });
  }

  async cancelFinish(): Promise<AckMessage | undefined> {
    const generation = this.retro.closing?.generation;
    if (!generation) return undefined;
    return await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "retro.cancelFinish",
      payload: { generation }
    });
  }

  async retryFinish(): Promise<void> {
    const generation = this.retro.closing?.generation;
    if (!generation) return;
    const cancelled = await this.cancelFinish();
    if (!cancelled) return;
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "retro.prepareFinish",
      payload: { expectedRetroRevision: cancelled.resultingRevision }
    });
  }

  async finishSavedContent(): Promise<void> {
    const generation = this.retro.closing?.generation;
    if (!generation) return;
    await this.sendCommand({
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "retro.finalizeFinish",
      payload: {
        generation,
        forceSavedContent: true,
        confirmation: "finish-saved-content"
      }
    });
  }

  async flushBeforeNavigation(): Promise<boolean> {
    if (this.retro.status === "closed") {
      this.persistAllDrafts();
      return true;
    }
    return this.flushAllLocal();
  }

  async flushCard(cardId: string): Promise<boolean> {
    return this.scheduler.flush(cardId);
  }

  retainDrafts(): void {
    this.persistAllDrafts();
  }

  async retryCard(cardId: string): Promise<void> {
    if (this.retro.status !== "open") return;
    const view = this.scheduler.get(cardId);
    if (view?.inFlight) {
      this.scheduler.retry(cardId);
      await this.scheduler.flush(cardId);
      return;
    }
    if (view?.status === "conflict") {
      this.scheduler.useMyDraft(cardId);
      return;
    }
    if (this.draftsStore.hasPending(cardId)) {
      for (const command of this.draftsStore.pendingCommands()) {
        if (this.commandCardId(command) === cardId) this.sendRaw(command);
      }
      return;
    }
    const card = this.retro.cards[cardId];
    if (card) this.scheduler.edit(cardId, this.textFor(card));
  }

  useMyDraft(cardId: string): void {
    this.scheduler.useMyDraft(cardId);
  }

  keepSavedText(cardId: string): void {
    this.scheduler.keepSavedText(cardId);
    this.draftsStore.clearDraft(cardId);
  }

  async retryAll(): Promise<void> {
    this.actionError = undefined;
    this.retryUnknownCommands();
    const ok = await this.flushAllLocal();
    if (!ok) throw new Error("Some changes are still offline or need a conflict decision.");
  }

  async flushAllLocal(): Promise<boolean> {
    const pending = this.draftsStore.pendingCommands();
    const commandResults = await Promise.all(pending.map((command) => {
      const result = this.waitForCommand(command.commandId, 8_000);
      this.sendRaw(command);
      return result;
    }));
    if (commandResults.some((result) => result === undefined)) return false;
    return this.scheduler.flushAll(8_000);
  }

  private restoreLocalDrafts(): void {
    const pendingCommands = this.draftsStore.pendingCommands();
    for (const card of Object.values(this.retro.cards)) {
      const stored = this.draftsStore.getDraft(card.id);
      const pendingUpdate = pendingCommands.find(
        (command): command is Extract<ClientCommand, { type: "card.update" }> =>
          command.type === "card.update" && command.payload.cardId === card.id
      );
      if (pendingUpdate) {
        this.scheduler.restorePending(card.id, card.text, card.version, {
          cardId: card.id,
          text: pendingUpdate.payload.text,
          expectedCardVersion: pendingUpdate.payload.expectedCardVersion,
          commandId: pendingUpdate.commandId
        }, stored?.text ?? pendingUpdate.payload.text);
        if (this.composingCards.has(card.id)) this.scheduler.compositionStart(card.id);
      } else if (stored) {
        this.scheduler.restoreDraft(card.id, card.text, card.version, stored.text, stored.version, this.retro.status !== "closed");
        if (this.composingCards.has(card.id)) this.scheduler.compositionStart(card.id);
      } else {
        this.scheduler.register(card.id, card.text, card.version);
      }
    }
    for (const command of pendingCommands) {
      if (command.type !== "card.create") continue;
      const cardId = command.payload.cardId;
      if (this.retro.cards[cardId]) continue;
      const participant = this.retro.participants[this.actorId];
      if (!participant) continue;
      const now = new Date().toISOString();
      const stored = this.draftsStore.getDraft(cardId);
      this.localCards[cardId] = {
        id: cardId,
        columnId: command.payload.columnId,
        text: stored?.text ?? command.payload.text,
        authorId: this.actorId,
        authorDisplayName: participant.displayName,
        version: 1,
        createdAt: now,
        updatedAt: now
      };
    }
  }

  private dispatchAutosave(update: AutosaveUpdate): void {
    const command = this.updateCommand(update);
    this.draftsStore.setDraft(update.cardId, update.text, update.expectedCardVersion);
    void this.sendCommand(command).catch((error: unknown) => {
      if (this.isUnknownOutcome(error)) {
        this.scheduler.networkFailure(update.cardId, update.commandId, userSafeError(error));
      } else {
        void this.handleCardCommandError(command, error);
      }
    });
  }

  private updateCommand(update: AutosaveUpdate): ClientCommand {
    return ClientCommandSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      commandId: update.commandId,
      type: "card.update",
      payload: {
        cardId: update.cardId,
        text: update.text,
        expectedCardVersion: update.expectedCardVersion
      }
    });
  }

  private sendCommand(command: ClientCommand): Promise<AckMessage> {
    const valid = ClientCommandSchema.parse(command);
    this.actionError = undefined;
    this.draftsStore.putCommand(valid);
    const promise = this.waitForCommand(valid.commandId, 15_000).then((ack) => {
      if (!ack) throw new Error("The server hasn’t confirmed this change yet. It remains saved on this device.");
      return ack;
    });
    this.sendRaw(valid);
    this.notify();
    return promise;
  }

  private sendRaw(command: ClientCommand): void {
    if (this.disposed) return;
    if (this.socket) {
      this.socket.send(command);
      return;
    }
    void this.sendHttp(command);
  }

  private async sendHttp(command: ClientCommand): Promise<void> {
    try {
      const frame = CommandFrameSchema.parse({ protocolVersion: PROTOCOL_VERSION, commands: [command] });
      const response = await api.commandFrame(this.retro.id, frame);
      if (!response.acceptedCommandIds.includes(command.commandId)) {
        throw new Error("The server did not confirm this change.");
      }
      const retro = await api.retro(this.retro.id);
      this.applySnapshot(retro);
      const entityId = this.commandCardId(command);
      const entity = entityId ? retro.cards[entityId] : undefined;
      this.handleAck({
        type: "ack",
        protocolVersion: PROTOCOL_VERSION,
        retroId: this.retro.id,
        commandId: command.commandId,
        resultingRevision: response.resultingRevision,
        outcome: "applied",
        duplicate: false,
        ...(entity ? { entity: { kind: "card" as const, id: entity.id, version: entity.version } } : {}),
        processedAt: new Date().toISOString()
      });
    } catch (error) {
      await this.handleCommandFailure(command, error);
    }
  }

  private waitForCommand(commandId: string, timeoutMs: number): Promise<AckMessage | undefined> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.waiters.get(commandId)?.filter((item) => item !== waiter) ?? [];
          if (current.length === 0) this.waiters.delete(commandId);
          else this.waiters.set(commandId, current);
          resolve(undefined);
        }, timeoutMs)
      };
      this.waiters.set(commandId, [...(this.waiters.get(commandId) ?? []), waiter]);
    });
  }

  private settleCommand(commandId: string, ack: AckMessage): void {
    const waiters = this.waiters.get(commandId) ?? [];
    this.waiters.delete(commandId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(ack);
    }
  }

  private failCommandWaiters(commandId: string, error: Error): void {
    const waiters = this.waiters.get(commandId) ?? [];
    this.waiters.delete(commandId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "snapshot":
        this.clientId = message.clientId;
        this.applySnapshot(message.retro);
        if (message.retro.status === "closing") this.handleFinishRequested(message.retro.closing);
        break;
      case "events":
        for (const event of message.events) {
          const result = reduceRetroEvent(this.retro, event);
          if (result.status === "resync-required") {
            this.socket?.requestFreshSnapshot();
            return;
          }
          if (result.status === "applied") {
            this.retro = result.retro;
            if (event.type === "card.created") {
              this.registerCreatedCard(event.card);
            }
            if (event.type === "card.updated" || event.type === "card.moved") {
              const card = this.retro.cards[event.cardId];
              if (card) this.scheduler.reconcile(card.id, card.text, card.version);
            }
            if (event.type === "card.deleted") {
              this.scheduler.remove(event.cardId);
              delete this.draftViews[event.cardId];
              delete this.localCards[event.cardId];
              if (!this.draftsStore.hasPending(event.cardId)) this.draftsStore.clearDraft(event.cardId);
            }
            if (result.retro.status === "closed") {
              if (event.type === "retro.closed") this.confirmFinishFromClosedEvent(event);
              this.socket?.close();
              this.socketStatus = "offline";
            }
          }
        }
        this.notify();
        break;
      case "ack":
        this.handleAck(message);
        break;
      case "command.error":
        void this.handleSocketCommandError(message);
        break;
      case "presence":
        this.presence.set(message.clientId, message);
        this.notify();
        break;
      case "giphy.shared": {
        if (message.retroId !== this.retro.id) break;
        const previousTimer = this.giphyShareTimers.get(message.shareId);
        if (previousTimer !== undefined) clearTimeout(previousTimer);
        this.giphyShares.set(message.shareId, message);
        this.giphyShareTimers.set(message.shareId, setTimeout(() => {
          this.giphyShares.delete(message.shareId);
          this.giphyShareTimers.delete(message.shareId);
          this.notify();
        }, LIMITS.giphyShareLifetimeMs));
        this.notify();
        break;
      }
      case "finish.requested":
        this.retro = { ...this.retro, status: "closing", closing: message.closing };
        this.handleFinishRequested(message.closing);
        this.notify();
        break;
      case "finish.progress":
        this.progress = message;
        this.notify();
        if (message.readyCount === message.requiredCount) void this.finalizeIfCaptain(message.generation);
        break;
      case "retro.closed": {
        const result = reduceRetroEvent(this.retro, message.event);
        if (result.status === "applied") {
          this.retro = result.retro;
          this.confirmFinishFromClosedEvent(message.event);
          this.socket?.close();
          this.socketStatus = "offline";
        }
        this.notify();
        break;
      }
      case "auth.expiring":
        this.warnAboutExpiry();
        break;
      case "auth.required":
        this.authExpiring = true;
        this.socketStatus = "auth-required";
        this.notify();
        break;
      case "resync.required":
        this.socket?.requestFreshSnapshot();
        break;
    }
  }

  private applySnapshot(retro: Retro): void {
    if (retro.id !== this.retro.id) return;
    this.retro = retro;
    for (const card of Object.values(retro.cards)) {
      const view = this.scheduler.get(card.id);
      if (view) this.scheduler.reconcile(card.id, card.text, card.version);
      else if (this.localCards[card.id]) {
        this.registerCreatedCard(card);
      } else {
        this.scheduler.register(card.id, card.text, card.version);
      }
    }
    this.notify();
  }

  private handleAck(message: AckMessage): void {
    const command = this.draftsStore.pendingCommand(message.commandId);
    if (!command && !this.waiters.has(message.commandId)) {
      // Ephemeral presence commands are not persisted and have no ACK waiter.
      this.socket?.acknowledge(message.commandId);
      return;
    }
    this.socket?.acknowledge(message.commandId);
    if (command?.type === "card.update" && message.entity === undefined) {
      void api.retro(this.retro.id).then((retro) => {
        this.applySnapshot(retro);
        const card = retro.cards[command.payload.cardId];
        this.draftsStore.removeCommand(message.commandId);
        if (card && card.text === command.payload.text) {
          this.scheduler.acknowledge(command.payload.cardId, message.commandId, card.version);
          this.settleCommand(message.commandId, message);
        } else {
          this.scheduler.reject(
            command.payload.cardId,
            message.commandId,
            "The saved version changed before this draft arrived.",
            card ? { text: card.text, version: card.version } : undefined,
            Boolean(card)
          );
          this.failCommandWaiters(message.commandId, new Error("The saved version changed before this draft arrived."));
        }
      }).catch((error: unknown) => {
        this.scheduler.networkFailure(command.payload.cardId, message.commandId, userSafeError(error));
      });
      return;
    }
    this.draftsStore.removeCommand(message.commandId);
    if (command?.type === "card.create") {
      const cardId = command.payload.cardId;
      delete this.commandErrors[cardId];
      const card = this.retro.cards[cardId] ?? this.localCards[cardId];
      const version = message.entity?.version ?? card?.version ?? 1;
      const savedText = this.retro.cards[cardId]?.text ?? "";
      const localDraft = this.draftsStore.getDraft(cardId);
      this.scheduler.register(cardId, savedText, version);
      if (this.composingCards.has(cardId)) this.scheduler.compositionStart(cardId);
      if (localDraft && localDraft.text !== savedText) this.scheduler.edit(cardId, localDraft.text);
      delete this.localCards[cardId];
    }
    if (command?.type === "card.update") {
      const cardId = command.payload.cardId;
      const version = message.entity?.version;
      if (version !== undefined) {
        if (this.scheduler.get(cardId)?.inFlight?.commandId === message.commandId) {
          const current = this.retro.cards[cardId];
          this.scheduler.acknowledge(
            cardId,
            message.commandId,
            version,
            current && current.version >= version ? { text: current.text, version: current.version } : undefined
          );
        } else {
          const card = this.retro.cards[cardId];
          if (card && version >= (this.scheduler.get(cardId)?.version ?? 0)) this.scheduler.reconcile(cardId, card.text, version);
        }
      }
    }
    if (command?.type === "card.move" && message.entity) {
      const card = this.retro.cards[command.payload.cardId];
      if (card) this.scheduler.reconcile(card.id, card.text, message.entity.version);
    }
    this.settleCommand(message.commandId, message);
    this.actionError = undefined;
    this.notify();
  }

  private async handleSocketCommandError(message: Extract<ServerMessage, { type: "command.error" }>): Promise<void> {
    const command = this.draftsStore.pendingCommands().find((item) => item.commandId === message.commandId);
    this.socket?.acknowledge(message.commandId);
    this.draftsStore.removeCommand(message.commandId);
    const error = new ApiRequestError(message.error, message.error.code === "CONFLICT" ? 409 : 400);
    if (command?.type === "card.update") {
      let serverCard = this.retro.cards[command.payload.cardId];
      try {
        const fresh = await api.retro(this.retro.id);
        this.applySnapshot(fresh);
        serverCard = fresh.cards[command.payload.cardId];
      } catch {
        // Keep the retained draft and let a later snapshot resolve the conflict.
      }
      this.scheduler.reject(
        command.payload.cardId,
        message.commandId,
        message.error.message,
        serverCard ? { text: serverCard.text, version: serverCard.version } : undefined,
        message.error.code === "CONFLICT" || message.error.code === "RESYNC_REQUIRED"
      );
      this.failCommandWaiters(message.commandId, error);
    } else {
      if (command?.type === "card.create") {
        this.commandErrors[command.payload.cardId] = message.error.message;
      }
      this.actionError = message.error.message;
      this.failCommandWaiters(message.commandId, error);
    }
    this.notify();
  }

  private async handleCommandFailure(command: ClientCommand, error: unknown): Promise<void> {
    if (this.isUnknownOutcome(error)) {
      const cardId = this.commandCardId(command);
      if (cardId && command.type === "card.update") {
        this.scheduler.networkFailure(cardId, command.commandId, userSafeError(error));
      }
      this.socketStatus = "offline";
      this.notify();
      return;
    }
    const cardId = this.commandCardId(command);
    this.draftsStore.removeCommand(command.commandId);
    if (command.type === "card.update" && cardId && this.scheduler.get(cardId)?.inFlight?.commandId === command.commandId) {
      await this.handleCardCommandError(command, error);
    }
    else {
      this.actionError = userSafeError(error);
      this.failCommandWaiters(command.commandId, error instanceof Error ? error : new Error(userSafeError(error)));
      if (command.type === "card.create") this.commandErrors[command.payload.cardId] = userSafeError(error);
      this.notify();
    }
  }

  private async handleCardCommandError(command: ClientCommand, error: unknown): Promise<void> {
    if (command.type !== "card.update") return;
    const view = this.scheduler.get(command.payload.cardId);
    const update = view?.inFlight;
    if (!update) return;
    let serverCard = this.retro.cards[command.payload.cardId];
    try {
      const fresh = await api.retro(this.retro.id);
      this.applySnapshot(fresh);
      serverCard = fresh.cards[command.payload.cardId];
    } catch {
      // The durable local draft stays visible if the snapshot is unavailable.
    }
    const requestError = error instanceof ApiRequestError ? error : undefined;
    const conflict = requestError?.code === "CONFLICT" || requestError?.code === "RESYNC_REQUIRED";
    this.scheduler.reject(
      command.payload.cardId,
      command.commandId,
      userSafeError(error),
      serverCard ? { text: serverCard.text, version: serverCard.version } : undefined,
      conflict
    );
    this.failCommandWaiters(command.commandId, error instanceof Error ? error : new Error(userSafeError(error)));
  }

  private handleFinishRequested(closing: Retro["closing"]): void {
    if (!closing || this.disposed) return;
    const clientId = this.clientId;
    if (!clientId || !closing.requiredClients.some((client) => client.clientId === clientId)) return;
    if (closing.readyClients.some((client) => client.clientId === clientId)) return;
    const key = `${closing.generation}:${clientId}`;
    if (this.readyGenerations.has(key)) return;
    this.readyGenerations.add(key);
    void this.flushAllLocal().then(async (saved) => {
      if (!saved || this.retro.status !== "closing" || this.retro.closing?.generation !== closing.generation) {
        this.readyGenerations.delete(key);
        return;
      }
      await this.sendCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: createOpaqueId(),
        type: "retro.finishReady",
        payload: { generation: closing.generation }
      });
    }).catch((error: unknown) => {
      this.readyGenerations.delete(key);
      this.actionError = userSafeError(error);
      this.notify();
    });
  }

  private async finalizeIfCaptain(generation: string): Promise<void> {
    if (this.retro.captainId !== this.actorId || this.retro.status !== "closing") return;
    if (this.finalizedGenerations.has(generation)) return;
    this.finalizedGenerations.add(generation);
    try {
      await this.sendCommand({
        protocolVersion: PROTOCOL_VERSION,
        commandId: createOpaqueId(),
        type: "retro.finalizeFinish",
        payload: { generation }
      });
    } catch (error) {
      this.finalizedGenerations.delete(generation);
      this.actionError = userSafeError(error);
      this.notify();
    }
  }

  private async sendPresence(cardId: string, editing: boolean): Promise<void> {
    if (!this.socket || this.socketStatus === "auth-required") return;
    const command: ClientCommand = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: createOpaqueId(),
      type: "presence.editing",
      payload: { cardId, editing }
    };
    this.socket.send(command);
  }

  private async retryUnknownCommands(): Promise<void> {
    for (const command of this.draftsStore.pendingCommands()) this.sendRaw(command);
  }

  private registerCreatedCard(card: Card): void {
    const localDraft = this.draftsStore.getDraft(card.id);
    const hadLocalCard = Boolean(this.localCards[card.id]);
    delete this.localCards[card.id];
    if (this.scheduler.get(card.id)) {
      this.scheduler.reconcile(card.id, card.text, card.version);
      return;
    }
    if (hadLocalCard && localDraft) {
      this.scheduler.restoreDraft(card.id, card.text, card.version, localDraft.text, localDraft.version);
      if (this.composingCards.has(card.id)) this.scheduler.compositionStart(card.id);
      return;
    }
    this.scheduler.register(card.id, card.text, card.version);
  }

  private confirmFinishFromClosedEvent(event: Extract<PersistedBoardEvent, { type: "retro.closed" }>): void {
    for (const command of this.draftsStore.pendingCommands()) {
      if (command.type !== "retro.finalizeFinish" || command.payload.generation !== event.generation) continue;
      this.draftsStore.removeCommand(command.commandId);
      this.socket?.acknowledge(command.commandId);
      this.settleCommand(command.commandId, {
        type: "ack",
        protocolVersion: PROTOCOL_VERSION,
        retroId: this.retro.id,
        commandId: command.commandId,
        resultingRevision: event.revision,
        outcome: "applied",
        duplicate: false,
        processedAt: event.occurredAt
      });
    }
  }

  private warnAboutExpiry(): void {
    if (this.authExpiring) return;
    this.authExpiring = true;
    this.notify();
    if (this.retro.status !== "closed") void this.flushAllLocal();
  }

  private onAutosaveChange(cardId: string, view: AutosaveView): void {
    this.draftViews[cardId] = view;
    if (view.status === "saved" && !view.inFlight) {
      this.draftsStore.clearDraft(cardId);
    } else {
      this.draftsStore.setDraft(cardId, view.text, view.version);
      if (view.inFlight) this.draftsStore.putCommand(this.updateCommand(view.inFlight));
    }
    this.notify();
  }

  private persistAllDrafts(): void {
    for (const [cardId, view] of Object.entries(this.draftViews)) {
      if (view.status !== "saved") this.draftsStore.setDraft(cardId, view.text, view.version);
    }
  }

  private isUnknownOutcome(error: unknown): boolean {
    return !(error instanceof ApiRequestError) || error.code === "INTERNAL_ERROR" || error.code === "AUTH_REQUIRED";
  }

  private commandCardId(command: ClientCommand): string | undefined {
    switch (command.type) {
      case "card.create": return command.payload.cardId;
      case "card.update":
      case "card.delete":
      case "card.move": return command.payload.cardId;
      case "card.reorder": return command.payload.cardId;
      case "reaction.set": return command.payload.cardId;
      case "presence.editing": return command.payload.cardId;
      default: return undefined;
    }
  }

  private notify(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}

export function statusLabel(status?: AutosaveStatus): string {
  switch (status) {
    case "saving": return "Saving";
    case "unsaved": return "Unsaved changes";
    case "error": return "Not saved";
    case "conflict": return "Draft conflict";
    default: return "Saved";
  }
}
