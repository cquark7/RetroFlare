import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, PROTOCOL_VERSION } from "../../src/shared/constants";
import { AutosaveScheduler, type AutosaveUpdate } from "../../src/client/sync/autosave";
import { DraftStore } from "../../src/client/sync/drafts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  writes = 0;

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.writes += 1; this.values.set(key, value); }
}

describe("per-card autosave scheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("sends a short typing burst after the three-second quiet period, with no idle writes", () => {
    vi.useFakeTimers();
    const dispatched: AutosaveUpdate[] = [];
    const scheduler = new AutosaveScheduler({ onDispatch: (update) => dispatched.push(update) });
    scheduler.register("00000000-0000-4000-8000-000000000001", "", 1);

    scheduler.edit("00000000-0000-4000-8000-000000000001", "A useful note");
    vi.advanceTimersByTime(LIMITS.draftTrailingSaveMs - 1);
    expect(dispatched).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe("A useful note");

    scheduler.acknowledge(dispatched[0]!.cardId, dispatched[0]!.commandId, 2);
    vi.advanceTimersByTime(10_000);
    expect(dispatched).toHaveLength(1);
    expect(scheduler.get(dispatched[0]!.cardId)?.status).toBe("saved");
    scheduler.dispose();
  });

  it("dispatches continuous typing by the five-second max wait", () => {
    vi.useFakeTimers();
    const dispatched: AutosaveUpdate[] = [];
    const cardId = "00000000-0000-4000-8000-000000000002";
    const scheduler = new AutosaveScheduler({ onDispatch: (update) => dispatched.push(update) });
    scheduler.register(cardId, "", 1);
    scheduler.edit(cardId, "0");

    for (let second = 1; second < 5; second += 1) {
      vi.advanceTimersByTime(1_000);
      scheduler.edit(cardId, String(second));
    }
    vi.advanceTimersByTime(LIMITS.draftMaximumWaitMs - 200 - 4_000 - 1);
    expect(dispatched).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.text).toBe("4");
    scheduler.dispose();
  });

  it("holds IME composition text until composition ends", () => {
    vi.useFakeTimers();
    const dispatched: AutosaveUpdate[] = [];
    const cardId = "00000000-0000-4000-8000-000000000008";
    const scheduler = new AutosaveScheduler({ onDispatch: (update) => dispatched.push(update) });
    scheduler.register(cardId, "", 1);
    scheduler.compositionStart(cardId);
    scheduler.edit(cardId, "composing");
    vi.advanceTimersByTime(LIMITS.draftMaximumWaitMs * 2);
    expect(dispatched).toHaveLength(0);
    scheduler.compositionEnd(cardId, "composed text");
    vi.advanceTimersByTime(LIMITS.draftTrailingSaveMs - 1);
    expect(dispatched).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(dispatched[0]?.text).toBe("composed text");
    scheduler.dispose();
  });

  it("keeps one update in flight and sends newer text after the ACK without overwriting it", () => {
    vi.useFakeTimers();
    const dispatched: AutosaveUpdate[] = [];
    const cardId = "00000000-0000-4000-8000-000000000003";
    const scheduler = new AutosaveScheduler({ onDispatch: (update) => dispatched.push(update) });
    scheduler.register(cardId, "Saved", 4);
    scheduler.edit(cardId, "First draft");
    vi.advanceTimersByTime(LIMITS.draftTrailingSaveMs);
    expect(dispatched).toHaveLength(1);
    const first = dispatched[0]!;

    scheduler.edit(cardId, "Newer draft");
    vi.advanceTimersByTime(LIMITS.draftMaximumWaitMs * 2);
    expect(dispatched).toHaveLength(1);
    expect(scheduler.get(cardId)?.text).toBe("Newer draft");

    scheduler.acknowledge(cardId, first.commandId, 5);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.text).toBe("Newer draft");
    expect(dispatched[1]?.expectedCardVersion).toBe(5);

    scheduler.acknowledge(cardId, dispatched[1]!.commandId, 6);
    expect(scheduler.get(cardId)).toMatchObject({ text: "Newer draft", savedText: "Newer draft", version: 6, status: "saved" });
    vi.advanceTimersByTime(10_000);
    expect(dispatched).toHaveLength(2);
    scheduler.dispose();
  });

  it("preserves a version-conflicted draft until the person chooses how to resolve it", () => {
    vi.useFakeTimers();
    const dispatched: AutosaveUpdate[] = [];
    const cardId = "00000000-0000-4000-8000-000000000004";
    const scheduler = new AutosaveScheduler({ onDispatch: (update) => dispatched.push(update) });
    scheduler.restoreDraft(cardId, "Saved by another tab", 3, "My offline draft", 2);
    expect(scheduler.get(cardId)).toMatchObject({ status: "conflict", text: "My offline draft" });
    vi.advanceTimersByTime(20_000);
    expect(dispatched).toHaveLength(0);

    scheduler.useMyDraft(cardId);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ text: "My offline draft", expectedCardVersion: 3 });
    scheduler.dispose();
  });
});

describe("short-lived local recovery", () => {
  it("does not persist when an ACK references an untracked command", () => {
    const storage = new MemoryStorage();
    const store = new DraftStore(
      "https://retro.example.test",
      "actor:demo-user",
      "00000000-0000-4000-8000-000000000005",
      storage
    );
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: "00000000-0000-4000-8000-000000000007",
      type: "reaction.set" as const,
      payload: {
        cardId: "00000000-0000-4000-8000-000000000006",
        emoji: "👍" as const,
        reacted: true
      }
    };

    store.putCommand(command);
    const writesAfterPut = storage.writes;
    expect(store.pendingCommand(command.commandId)).toEqual(command);
    store.removeCommand("00000000-0000-4000-8000-000000000008");
    expect(storage.writes).toBe(writesAfterPut);

    store.removeCommand(command.commandId);
    expect(storage.writes).toBe(writesAfterPut + 1);
    expect(store.pendingCommand(command.commandId)).toBeUndefined();
  });

  it("preserves text drafts when a protocol upgrade makes a pending command obsolete", () => {
    const storage = new MemoryStorage();
    const origin = "https://retro.example.test";
    const actorId = "actor:demo-user";
    const retroId = "00000000-0000-4000-8000-000000000005";
    const cardId = "00000000-0000-4000-8000-000000000006";
    const now = 1_000_000;
    storage.setItem(`siq-retro:draft:${encodeURIComponent(origin)}:${encodeURIComponent(actorId)}:${retroId}`, JSON.stringify({
      drafts: { [cardId]: { text: "Keep my offline thought", version: 2, updatedAt: now } },
      commands: [{ command: { protocolVersion: 2, commandId: crypto.randomUUID(), type: "vote.set", payload: { cardId, voted: true } }, updatedAt: now }]
    }));
    const restored = new DraftStore(origin, actorId, retroId, storage, now + 1);
    expect(restored.getDraft(cardId)?.text).toBe("Keep my offline thought");
    expect(restored.pendingCommands()).toEqual([]);
  });

  it("continues a legacy draft without overwriting a separate new-format draft", () => {
    const storage = new MemoryStorage();
    const origin = "https://retro.example.test";
    const actorId = "actor:demo-user";
    const retroId = "00000000-0000-4000-8000-000000000005";
    const cardId = "00000000-0000-4000-8000-000000000006";
    const suffix = `draft:${encodeURIComponent(origin)}:${encodeURIComponent(actorId)}:${retroId}`;
    const oldKey = `siq-retro:${suffix}`;
    const newKey = `retroflare:${suffix}`;
    const now = 1_000_000;
    storage.setItem(oldKey, JSON.stringify({ drafts: { [cardId]: { text: "Earlier draft", version: 2, updatedAt: now } }, commands: [] }));
    const separateDraft = JSON.stringify({ drafts: { [cardId]: { text: "Separate draft", version: 2, updatedAt: now } }, commands: [] });
    storage.setItem(newKey, separateDraft);

    const restored = new DraftStore(origin, actorId, retroId, storage, now + 1);
    expect(restored.getDraft(cardId)?.text).toBe("Earlier draft");
    restored.setDraft(cardId, "Continued draft", 2, now + 2);
    expect(storage.getItem(oldKey)).toContain("Continued draft");
    expect(storage.getItem(newKey)).toBe(separateDraft);

    DraftStore.clearActor(origin, actorId, storage);
    expect(storage.getItem(oldKey)).toBeNull();
    expect(storage.getItem(newKey)).toBeNull();
  });

  it("expires drafts after 24 hours and retains the original command ID until acknowledged", () => {
    const storage = new MemoryStorage();
    const actorId = "actor:demo-user";
    const retroId = "00000000-0000-4000-8000-000000000005";
    const cardId = "00000000-0000-4000-8000-000000000006";
    const now = 1_000_000;
    const store = new DraftStore("https://retro.example.test", actorId, retroId, storage, now);
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: "00000000-0000-4000-8000-000000000007",
      type: "card.update" as const,
      payload: { cardId, text: "Unsent", expectedCardVersion: 2 }
    };
    store.setDraft(cardId, "Unsent", 2, now);
    store.putCommand(command, now);

    const restored = new DraftStore("https://retro.example.test", actorId, retroId, storage, now + 1);
    expect(restored.getDraft(cardId)?.text).toBe("Unsent");
    expect(restored.pendingCommands()[0]?.commandId).toBe(command.commandId);

    const expired = new DraftStore("https://retro.example.test", actorId, retroId, storage, now + LIMITS.localDraftLifetimeMs + 1);
    expect(expired.getDraft(cardId)).toBeUndefined();
    expect(expired.pendingCommands()).toEqual([]);
  });
});
