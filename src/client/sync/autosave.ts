import { LIMITS } from "../../shared/constants";
import { createOpaqueId } from "../../shared/ids";

export type AutosaveStatus = "saved" | "saving" | "unsaved" | "error" | "conflict";

export type AutosaveUpdate = {
  cardId: string;
  text: string;
  expectedCardVersion: number;
  commandId: string;
};

export type AutosaveConflict = {
  savedText: string;
  savedVersion: number;
};

export type AutosaveView = {
  text: string;
  savedText: string;
  version: number;
  status: AutosaveStatus;
  error?: string;
  conflict?: AutosaveConflict;
  inFlight?: AutosaveUpdate;
};

type Entry = AutosaveView & {
  dirtySince?: number;
  trailingTimer?: ReturnType<typeof setTimeout>;
  maximumTimer?: ReturnType<typeof setTimeout>;
  composing: boolean;
  waiters: Array<(saved: boolean) => void>;
};

export type AutosaveOptions = {
  trailingMs?: number;
  maximumWaitMs?: number;
  now?: () => number;
  onDispatch: (update: AutosaveUpdate) => void;
  onChange?: (cardId: string, view: AutosaveView) => void;
};

/** Per-card dirty draft scheduler. Timers never reset the first unsent deadline. */
export class AutosaveScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly trailingMs: number;
  private readonly maximumWaitMs: number;
  private readonly now: () => number;
  private readonly onDispatch: AutosaveOptions["onDispatch"];
  private readonly onChange: NonNullable<AutosaveOptions["onChange"]>;

  constructor(options: AutosaveOptions) {
    this.trailingMs = options.trailingMs ?? LIMITS.draftTrailingSaveMs;
    // Leave a small scheduling margin so a busy browser still dispatches
    // within the protocol's five-second maximum-wait bound.
    this.maximumWaitMs = options.maximumWaitMs ?? LIMITS.draftMaximumWaitMs - 200;
    this.now = options.now ?? Date.now;
    this.onDispatch = options.onDispatch;
    this.onChange = options.onChange ?? (() => undefined);
  }

  register(cardId: string, text: string, version: number): AutosaveView {
    const existing = this.entries.get(cardId);
    if (existing) {
      this.reconcile(cardId, text, version);
      return this.publicView(existing);
    }
    const entry: Entry = {
      text,
      savedText: text,
      version,
      status: "saved",
      composing: false,
      waiters: []
    };
    this.entries.set(cardId, entry);
    this.notify(cardId, entry);
    return this.publicView(entry);
  }

  get(cardId: string): AutosaveView | undefined {
    const entry = this.entries.get(cardId);
    return entry ? this.publicView(entry) : undefined;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  edit(cardId: string, text: string): void {
    const entry = this.entries.get(cardId);
    if (!entry) return;
    entry.text = text;
    entry.error = undefined;
    if (entry.conflict) {
      this.notify(cardId, entry);
      return;
    }
    if (entry.text === entry.savedText && !entry.inFlight) {
      this.clearTimers(entry);
      entry.dirtySince = undefined;
      entry.status = "saved";
      this.resolveWaiters(entry, true);
      this.notify(cardId, entry);
      return;
    }
    if (entry.dirtySince === undefined) {
      entry.dirtySince = this.now();
      entry.maximumTimer = setTimeout(() => this.tryDispatch(cardId), this.maximumWaitMs);
    }
    if (entry.trailingTimer !== undefined) clearTimeout(entry.trailingTimer);
    if (!entry.composing) {
      entry.trailingTimer = setTimeout(() => this.tryDispatch(cardId), this.trailingMs);
    }
    entry.status = entry.inFlight ? "saving" : "unsaved";
    this.notify(cardId, entry);
  }

  compositionStart(cardId: string): void {
    const entry = this.entries.get(cardId);
    if (!entry) return;
    entry.composing = true;
    if (entry.trailingTimer !== undefined) clearTimeout(entry.trailingTimer);
    entry.trailingTimer = undefined;
  }

  compositionEnd(cardId: string, text: string): void {
    const entry = this.entries.get(cardId);
    if (!entry) return;
    entry.composing = false;
    this.edit(cardId, text);
  }

  /** Deliberate blur/navigation/close flush. Resolves false if the write does not ACK. */
  async flush(cardId: string, timeoutMs = 8_000): Promise<boolean> {
    const entry = this.entries.get(cardId);
    if (!entry) return true;
    if (entry.composing) return false;
    if (entry.conflict) return false;
    if (!entry.inFlight && entry.text !== entry.savedText) this.tryDispatch(cardId);
    if (!entry.inFlight && entry.text === entry.savedText) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (saved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(saved);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      entry.waiters.push(done);
    });
  }

  async flushAll(timeoutMs = 8_000): Promise<boolean> {
    const results = await Promise.all(this.ids().map((cardId) => this.flush(cardId, timeoutMs)));
    return results.every(Boolean);
  }

  acknowledge(
    cardId: string,
    commandId: string,
    version: number,
    current?: { text: string; version: number }
  ): void {
    const entry = this.entries.get(cardId);
    if (!entry || entry.inFlight?.commandId !== commandId) return;
    const sentText = entry.inFlight.text;
    entry.inFlight = undefined;
    const latest = current && current.version > version ? current : undefined;
    entry.savedText = latest?.text ?? sentText;
    entry.version = latest?.version ?? version;
    entry.error = undefined;
    entry.conflict = undefined;
    if (latest && latest.text !== sentText && latest.text !== entry.text) {
      entry.conflict = { savedText: latest.text, savedVersion: latest.version };
      entry.error = "This card was also changed in another tab.";
      entry.status = "conflict";
      this.clearTimers(entry);
      this.resolveWaiters(entry, false);
      this.notify(cardId, entry);
      return;
    }
    if (entry.text !== entry.savedText) {
      entry.dirtySince ??= this.now();
      this.clearTimers(entry);
      this.tryDispatch(cardId);
      return;
    }
    entry.dirtySince = undefined;
    entry.status = "saved";
    this.clearTimers(entry);
    this.resolveWaiters(entry, true);
    this.notify(cardId, entry);
  }

  /** Keep an unknown-outcome command intact so reconnect can retry the same payload and ID. */
  networkFailure(cardId: string, commandId: string, message: string): void {
    const entry = this.entries.get(cardId);
    if (!entry || entry.inFlight?.commandId !== commandId) return;
    entry.error = message;
    entry.status = "unsaved";
    this.notify(cardId, entry);
    this.resolveWaiters(entry, false);
  }

  reject(
    cardId: string,
    commandId: string,
    message: string,
    server?: { text: string; version: number },
    conflict = false
  ): void {
    const entry = this.entries.get(cardId);
    if (!entry || entry.inFlight?.commandId !== commandId) return;
    entry.inFlight = undefined;
    entry.error = message;
    if (conflict && server) {
      entry.conflict = { savedText: server.text, savedVersion: server.version };
      entry.status = "conflict";
    } else {
      entry.status = "error";
      entry.dirtySince = undefined;
      this.clearTimers(entry);
    }
    this.resolveWaiters(entry, false);
    this.notify(cardId, entry);
  }

  retry(cardId: string): void {
    const entry = this.entries.get(cardId);
    if (!entry?.inFlight) {
      if (entry && entry.text !== entry.savedText) this.edit(cardId, entry.text);
      return;
    }
    entry.error = undefined;
    entry.status = "saving";
    this.notify(cardId, entry);
    this.onDispatch(entry.inFlight);
  }

  reconcile(cardId: string, savedText: string, version: number): void {
    const entry = this.entries.get(cardId);
    if (!entry) {
      this.register(cardId, savedText, version);
      return;
    }
    if (entry.status === "saved" || (entry.text === entry.savedText && !entry.inFlight)) {
      entry.text = savedText;
      entry.savedText = savedText;
      entry.version = version;
      entry.error = undefined;
      entry.conflict = undefined;
      this.notify(cardId, entry);
      return;
    }
    if (!entry.inFlight && version !== entry.version) {
      entry.conflict = { savedText, savedVersion: version };
      entry.error = "This card was also changed in another tab.";
      entry.status = "conflict";
      this.notify(cardId, entry);
    }
  }

  restoreDraft(
    cardId: string,
    savedText: string,
    version: number,
    draftText: string,
    draftVersion: number,
    schedule = true
  ): void {
    const entry: Entry = {
      text: draftText,
      savedText,
      version,
      status: "unsaved",
      composing: false,
      waiters: []
    };
    this.entries.set(cardId, entry);
    if (draftText !== savedText && draftVersion !== version) {
      entry.status = "conflict";
      entry.conflict = { savedText, savedVersion: version };
      entry.error = "A saved version changed while this draft was away.";
    } else if (draftText !== savedText) {
      if (schedule) {
        this.edit(cardId, draftText);
        return;
      }
      entry.status = "unsaved";
    } else {
      entry.status = "saved";
    }
    this.notify(cardId, entry);
  }

  restorePending(
    cardId: string,
    savedText: string,
    version: number,
    update: AutosaveUpdate,
    currentText = update.text
  ): void {
    const entry: Entry = {
      text: currentText,
      savedText,
      version,
      status: "saving",
      inFlight: update,
      composing: false,
      waiters: []
    };
    this.entries.set(cardId, entry);
    this.notify(cardId, entry);
  }

  useMyDraft(cardId: string): void {
    const entry = this.entries.get(cardId);
    if (!entry?.conflict) return;
    entry.savedText = entry.conflict.savedText;
    entry.version = entry.conflict.savedVersion;
    entry.conflict = undefined;
    entry.error = undefined;
    entry.dirtySince = this.now();
    this.clearTimers(entry);
    this.tryDispatch(cardId);
  }

  keepSavedText(cardId: string): void {
    const entry = this.entries.get(cardId);
    if (!entry?.conflict) return;
    entry.text = entry.conflict.savedText;
    entry.savedText = entry.conflict.savedText;
    entry.version = entry.conflict.savedVersion;
    entry.inFlight = undefined;
    entry.conflict = undefined;
    entry.error = undefined;
    entry.dirtySince = undefined;
    entry.status = "saved";
    this.clearTimers(entry);
    this.resolveWaiters(entry, true);
    this.notify(cardId, entry);
  }

  remove(cardId: string): void {
    const entry = this.entries.get(cardId);
    if (!entry) return;
    this.clearTimers(entry);
    this.resolveWaiters(entry, false);
    this.entries.delete(cardId);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.clearTimers(entry);
      this.resolveWaiters(entry, false);
    }
    this.entries.clear();
  }

  private tryDispatch(cardId: string): void {
    const entry = this.entries.get(cardId);
    if (!entry || entry.composing || entry.conflict || entry.inFlight) return;
    if (entry.text === entry.savedText) {
      entry.dirtySince = undefined;
      entry.status = "saved";
      this.clearTimers(entry);
      this.resolveWaiters(entry, true);
      this.notify(cardId, entry);
      return;
    }
    const update: AutosaveUpdate = {
      cardId,
      text: entry.text,
      expectedCardVersion: entry.version,
      commandId: createOpaqueId()
    };
    entry.inFlight = update;
    entry.dirtySince = undefined;
    entry.status = "saving";
    entry.error = undefined;
    this.clearTimers(entry);
    this.notify(cardId, entry);
    this.onDispatch(update);
  }

  private clearTimers(entry: Entry): void {
    if (entry.trailingTimer !== undefined) clearTimeout(entry.trailingTimer);
    if (entry.maximumTimer !== undefined) clearTimeout(entry.maximumTimer);
    entry.trailingTimer = undefined;
    entry.maximumTimer = undefined;
  }

  private resolveWaiters(entry: Entry, saved: boolean): void {
    const pending = entry.waiters.splice(0);
    for (const resolve of pending) resolve(saved);
  }

  private publicView(entry: Entry): AutosaveView {
    return {
      text: entry.text,
      savedText: entry.savedText,
      version: entry.version,
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.conflict ? { conflict: { ...entry.conflict } } : {}),
      ...(entry.inFlight ? { inFlight: { ...entry.inFlight } } : {})
    };
  }

  private notify(cardId: string, entry: Entry): void {
    this.onChange(cardId, this.publicView(entry));
  }
}
