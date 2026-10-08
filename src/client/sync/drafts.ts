import { z } from "zod";
import { ClientCommandSchema, type ClientCommand } from "../../shared/protocol";
import { LIMITS } from "../../shared/constants";
import { LEGACY_STORAGE_PREFIX, STORAGE_PREFIX } from "../storage-keys";

const DraftRecordSchema = z.object({
  text: z.string().max(LIMITS.cardTextCharacters),
  version: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative()
}).strict();

const PendingCommandSchema = z.object({
  command: ClientCommandSchema,
  updatedAt: z.number().int().nonnegative()
}).strict();

const StoredDraftSessionSchema = z.object({
  drafts: z.record(z.string().uuid(), DraftRecordSchema),
  // Validate commands individually so a protocol upgrade never discards text drafts.
  commands: z.array(z.unknown())
}).strict();

export type StoredDraftRecord = z.infer<typeof DraftRecordSchema>;

export class DraftStore {
  private readonly storage: Storage;
  private readonly key: string;
  private readonly alternateKey: string;
  private readonly drafts = new Map<string, StoredDraftRecord>();
  private readonly commands = new Map<string, { command: ClientCommand; updatedAt: number }>();

  constructor(origin: string, actorId: string, retroId: string, storage: Storage = sessionStorage, now = Date.now()) {
    this.storage = storage;
    const suffix = `draft:${encodeURIComponent(origin)}:${encodeURIComponent(actorId)}:${encodeURIComponent(retroId)}`;
    const legacyKey = `${LEGACY_STORAGE_PREFIX}${suffix}`;
    let legacyExists = false;
    try {
      legacyExists = this.storage.getItem(legacyKey) !== null;
    } catch {
      // Storage can be unavailable. Keep the in-memory draft working.
    }
    // Keep writing an existing legacy session in place so no unsent draft is overwritten.
    this.key = legacyExists ? legacyKey : `${STORAGE_PREFIX}${suffix}`;
    this.alternateKey = legacyExists ? `${STORAGE_PREFIX}${suffix}` : legacyKey;
    this.restore(now);
  }

  getDraft(cardId: string): StoredDraftRecord | undefined {
    const draft = this.drafts.get(cardId);
    return draft ? { ...draft } : undefined;
  }

  listDrafts(): Record<string, StoredDraftRecord> {
    return Object.fromEntries([...this.drafts.entries()].map(([id, draft]) => [id, { ...draft }]));
  }

  setDraft(cardId: string, text: string, version: number, now = Date.now()): void {
    this.drafts.set(cardId, { text, version, updatedAt: now });
    this.persist();
  }

  clearDraft(cardId: string): void {
    this.drafts.delete(cardId);
    this.persist();
  }

  putCommand(command: ClientCommand, now = Date.now()): void {
    this.commands.set(command.commandId, { command, updatedAt: now });
    this.persist();
  }

  removeCommand(commandId: string): void {
    if (!this.commands.delete(commandId)) return;
    this.persist();
  }

  pendingCommand(commandId: string): ClientCommand | undefined {
    return this.commands.get(commandId)?.command;
  }

  pendingCommands(): ClientCommand[] {
    return [...this.commands.values()].map(({ command }) => command);
  }

  hasPending(cardId: string): boolean {
    return [...this.commands.values()].some(({ command }) => {
      if (command.type === "card.update" || command.type === "card.create" || command.type === "card.delete" || command.type === "card.move" || command.type === "card.reorder") {
        return command.payload.cardId === cardId;
      }
      return false;
    });
  }

  clear(): void {
    this.drafts.clear();
    this.commands.clear();
    this.storage.removeItem(this.key);
    this.storage.removeItem(this.alternateKey);
  }

  static clearActor(origin: string, actorId: string, storage: Storage = sessionStorage): void {
    const suffix = `draft:${encodeURIComponent(origin)}:${encodeURIComponent(actorId)}:`;
    const prefixes = [`${STORAGE_PREFIX}${suffix}`, `${LEGACY_STORAGE_PREFIX}${suffix}`];
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) storage.removeItem(key);
    }
  }

  private restore(now: number): void {
    let stored: string | null;
    try {
      stored = this.storage.getItem(this.key);
    } catch {
      return;
    }
    if (!stored) return;
    try {
      const parsed: unknown = JSON.parse(stored);
      const result = StoredDraftSessionSchema.safeParse(parsed);
      if (!result.success) {
        this.storage.removeItem(this.key);
        return;
      }
      const expiration = now - LIMITS.localDraftLifetimeMs;
      for (const [cardId, draft] of Object.entries(result.data.drafts)) {
        if (draft.updatedAt >= expiration) this.drafts.set(cardId, draft);
      }
      for (const entry of result.data.commands) {
        const command = PendingCommandSchema.safeParse(entry);
        if (command.success && command.data.updatedAt >= expiration) {
          this.commands.set(command.data.command.commandId, command.data);
        }
      }
      this.persist();
    } catch {
      this.storage.removeItem(this.key);
    }
  }

  private persist(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify({
        drafts: Object.fromEntries(this.drafts),
        commands: [...this.commands.values()]
      }));
    } catch {
      // Storage can be unavailable or full. Keep the live in-memory draft regardless.
    }
  }
}
