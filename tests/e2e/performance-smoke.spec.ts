import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ORIGIN = "http://localhost:5174";
const IDENTITIES = [
  "alex",
  "sam",
  "jordan",
  ...Array.from({ length: 12 }, (_, index) => `user-${String(index + 1).padStart(2, "0")}`)
];
const openedContexts: BrowserContext[] = [];

type AckRecord = { processedAt: number };
type Actor = {
  context: BrowserContext;
  page: Page;
  events: Set<string>;
  acknowledgements: Map<string, AckRecord[]>;
  presenceCommands: Map<string, { cardId: string; editing: boolean }>;
  presenceAcks: Set<string>;
  createdCardIds: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function eventKey(cardId: string, text: string): string {
  return JSON.stringify([cardId, text]);
}

function monitorWebSocket(page: Page): Pick<Actor, "events" | "acknowledgements" | "presenceCommands" | "presenceAcks" | "createdCardIds"> {
  const events = new Set<string>();
  const acknowledgements = new Map<string, AckRecord[]>();
  const presenceCommands = new Map<string, { cardId: string; editing: boolean }>();
  const presenceAcks = new Set<string>();
  const createdCardIds: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/retros/")) return;
    const commandKeys = new Map<string, string>();
    socket.on("framesent", (frame) => {
      let message: Record<string, unknown> | undefined;
      try {
        message = record(JSON.parse(String(frame.payload)) as unknown);
      } catch {
        return;
      }
      if (!Array.isArray(message?.commands)) return;
      for (const value of message.commands) {
        const command = record(value);
        const payload = record(command?.payload);
        if (command?.type === "card.create" && typeof payload?.cardId === "string") {
          createdCardIds.push(payload.cardId);
        }
        if (
          command?.type === "presence.editing" &&
          typeof command.commandId === "string" &&
          typeof payload?.cardId === "string" &&
          typeof payload.editing === "boolean"
        ) {
          presenceCommands.set(command.commandId, { cardId: payload.cardId, editing: payload.editing });
        }
        if (
          command?.type === "card.update" &&
          typeof command.commandId === "string" &&
          typeof payload?.cardId === "string" &&
          typeof payload.text === "string"
        ) {
          commandKeys.set(command.commandId, eventKey(payload.cardId, payload.text));
        }
      }
    });
    socket.on("framereceived", (frame) => {
      let message: Record<string, unknown> | undefined;
      try {
        message = record(JSON.parse(String(frame.payload)) as unknown);
      } catch {
        return;
      }
      if (message?.type === "ack" && typeof message.commandId === "string" && typeof message.processedAt === "string") {
        const key = commandKeys.get(message.commandId);
        const processedAt = Date.parse(message.processedAt);
        if (key && Number.isFinite(processedAt)) {
          acknowledgements.set(key, [...(acknowledgements.get(key) ?? []), { processedAt }]);
        }
        if (presenceCommands.has(message.commandId)) presenceAcks.add(message.commandId);
      }
      if (message?.type !== "events" || !Array.isArray(message.events)) return;
      for (const value of message.events) {
        const event = record(value);
        if (
          event?.type !== "card.updated" ||
          typeof event.cardId !== "string" ||
          typeof event.text !== "string"
        ) continue;
        events.add(eventKey(event.cardId, event.text));
      }
    });
  });
  return { events, acknowledgements, presenceCommands, presenceAcks, createdCardIds };
}

async function signIn(browser: Browser, identity: string): Promise<Actor> {
  const context = await browser.newContext({
    baseURL: ORIGIN,
    viewport: { width: 1440, height: 1000 }
  });
  openedContexts.push(context);
  await context.addInitScript(() => {
    const metricsWindow = window as Window & { __retroflareDraftStoreWrites?: number };
    const originalStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("retroflare:draft:")) {
        metricsWindow.__retroflareDraftStoreWrites = (metricsWindow.__retroflareDraftStoreWrites ?? 0) + 1;
      }
      originalStorageSetItem.call(this, key, value);
    };
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (!descriptor?.get || !descriptor.set) return;
    const originalSet = descriptor.set;
    const valueTimes = window as Window & { __retroflareTextareaValueTimes?: Record<string, number> };
    Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
      ...descriptor,
      set(this: HTMLTextAreaElement, value: string) {
        originalSet.call(this, value);
        if (!this.id.startsWith("card-")) return;
        const times = valueTimes.__retroflareTextareaValueTimes ??= {};
        times[JSON.stringify([this.id, value])] = Date.now();
      }
    });
  });
  const session = await context.request.post(`${ORIGIN}/api/local/session`, {
    headers: { Origin: ORIGIN },
    data: { identity }
  });
  if (!session.ok()) {
    throw new Error(`Could not authenticate local identity ${identity}: ${session.status()} ${await session.text()}`);
  }
  const page = await context.newPage();
  const monitor = monitorWebSocket(page);
  await page.goto("/");
  await expect(page.locator(".user-chip__name")).toBeVisible();
  return { context, page, ...monitor };
}

async function openAndJoin(actor: Actor, retroId: string, title: string, displayName: string): Promise<void> {
  await actor.page.goto(`/retro/${retroId}`);
  await expect(actor.page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(actor.page.getByRole("button", { name: "Join this retro" })).toBeVisible();
  await actor.page.getByLabel("Display name").fill(displayName);
  await actor.page.getByRole("button", { name: "Join this retro" }).click();
  await expect(actor.page.locator(".connection-note--online")).toBeVisible({ timeout: 20_000 });
}

async function addCard(actor: Actor): Promise<string> {
  const column = actor.page.locator(".board-column--went-well");
  const before = actor.createdCardIds.length;
  await column.getByRole("button", { name: "Add a card" }).click();
  await expect.poll(() => actor.createdCardIds.length).toBe(before + 1);
  const cardId = actor.createdCardIds[before];
  if (!cardId) throw new Error("The new card command did not contain a stable card ID.");
  await expect(column.locator(`#card-${cardId}`)).toBeVisible();
  return cardId;
}

async function waitForEvent(actor: Actor, cardId: string, text: string): Promise<void> {
  const key = eventKey(cardId, text);
  await expect.poll(() => actor.events.has(key), { timeout: 15_000 }).toBe(true);
}

async function waitForAcknowledgement(actor: Actor, cardId: string, text: string): Promise<AckRecord> {
  const key = eventKey(cardId, text);
  await expect.poll(() => actor.acknowledgements.get(key)?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  return actor.acknowledgements.get(key)![0]!;
}

async function waitForTextareaValue(page: Page, cardId: string, text: string): Promise<number> {
  const key = JSON.stringify([`card-${cardId}`, text]);
  const readTime = () => page.evaluate((storageKey) => {
    const windowWithMetrics = window as Window & { __retroflareTextareaValueTimes?: Record<string, number> };
    return windowWithMetrics.__retroflareTextareaValueTimes?.[storageKey] ?? 0;
  }, key);
  await expect.poll(readTime, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator(`#card-${cardId}`)).toHaveValue(text);
  return await readTime();
}

async function draftStoreWriteCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const metricsWindow = window as Window & { __retroflareDraftStoreWrites?: number };
    return metricsWindow.__retroflareDraftStoreWrites ?? 0;
  });
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

test.setTimeout(180_000);

test.afterEach(async () => {
  await Promise.all(openedContexts.splice(0).map((context) => context.close()));
});

test("measures live event-to-peer-render latency with 15 isolated clients", async ({ browser }) => {
  test.skip(
    process.env.RETROFLARE_RUN_15_CLIENT_PERF !== "1",
    "Set RETROFLARE_RUN_15_CLIENT_PERF=1 to run the opt-in local 15-client smoke test."
  );

  const actors = await Promise.all(IDENTITIES.map((identity) => signIn(browser, identity)));
  const captain = actors[0]!;
  const title = `15-client smoke ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;
  await captain.page.getByRole("button", { name: /Start a retro/ }).click();
  await captain.page.getByLabel("Retro title").fill(title);
  await captain.page.getByLabel("Your display name").fill("Participant 01");
  await captain.page.getByRole("button", { name: "Create retro" }).click();
  await expect(captain.page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(captain.page.locator(".connection-note--online")).toBeVisible({ timeout: 20_000 });
  const retroId = new URL(captain.page.url()).pathname.match(/\/retro\/([0-9a-f-]{36})/i)?.[1];
  if (!retroId) throw new Error("The performance smoke board ID was not found in the URL.");

  await Promise.all(actors.slice(1).map((actor, index) =>
    openAndJoin(actor, retroId, title, `Participant ${String(index + 2).padStart(2, "0")}`)
  ));
  await expect.poll(async () => {
    const response = await captain.context.request.get(`${ORIGIN}/api/retros/${retroId}`);
    const body = record(await response.json());
    const data = record(body?.data);
    const retro = record(data?.retro);
    const participants = record(retro?.participants);
    return participants ? Object.keys(participants).length : 0;
  }, { timeout: 20_000 }).toBe(IDENTITIES.length);
  await Promise.all(actors.map((actor) =>
    expect(actor.page.locator(".connection-note--online")).toBeVisible({ timeout: 20_000 })
  ));

  const cardIds = await Promise.all(actors.map((actor) => addCard(actor)));
  await Promise.all(actors.map(async (actor) => {
    await expect.poll(() => actor.page.locator(".idea-card").count(), { timeout: 20_000 })
      .toBe(IDENTITIES.length);
  }));

  const presenceActor = actors[0]!;
  const presenceCardId = cardIds[0]!;
  const presenceField = presenceActor.page.locator(`#card-${presenceCardId}`);
  await presenceField.fill("Presence ACK bookkeeping check");
  await expect(presenceActor.page.locator(`.idea-card[data-card-id="${presenceCardId}"] .save-state`))
    .toHaveText("Saved", { timeout: 10_000 });
  expect(await presenceField.evaluate((element) => document.activeElement === element)).toBe(true);
  const writesBeforePresenceAck = await draftStoreWriteCount(presenceActor.page);
  await presenceField.press("Enter");
  await expect.poll(() => [...presenceActor.presenceCommands.entries()].find(([, command]) =>
    command.cardId === presenceCardId && !command.editing
  )?.[0]).toBeTruthy();
  const presenceCommandId = [...presenceActor.presenceCommands.entries()].find(([, command]) =>
    command.cardId === presenceCardId && !command.editing
  )?.[0];
  if (!presenceCommandId) throw new Error("The editing-stop presence command was not observed.");
  await expect.poll(() => presenceActor.presenceAcks.has(presenceCommandId), { timeout: 10_000 }).toBe(true);
  expect(await draftStoreWriteCount(presenceActor.page)).toBe(writesBeforePresenceAck);

  const samples: { round: number; editor: number; observer: number; latencyMs: number }[] = [];
  const rounds = 3;
  for (let round = 0; round < rounds; round += 1) {
    const texts = cardIds.map((cardId, editor) => `perf-${round}-${editor}-${cardId.slice(0, 8)}`);
    const observations = actors.map((_, editor) => {
      const observer = (editor + 1) % actors.length;
      const peer = actors[observer]!;
      const cardId = cardIds[editor]!;
      const text = texts[editor]!;
      return (async () => {
        const [, acknowledgement] = await Promise.all([
          waitForEvent(peer, cardId, text),
          waitForAcknowledgement(actors[editor]!, cardId, text)
        ]);
        const renderedAt = await waitForTextareaValue(peer.page, cardId, text);
        return {
          round,
          editor,
          observer,
          latencyMs: renderedAt - acknowledgement.processedAt
        };
      })();
    });
    const updates = actors.map(async (actor, editor) => {
      const field = actor.page.locator(`#card-${cardIds[editor]}`);
      await field.fill(texts[editor]!);
      await field.press("Enter");
    });
    const [roundSamples] = await Promise.all([Promise.all(observations), Promise.all(updates)]);
    samples.push(...roundSamples);
    await Promise.all(actors.map((actor, editor) =>
      expect(actor.page.locator(`.idea-card[data-card-id="${cardIds[editor]}"] .save-state`))
        .toHaveText("Saved", { timeout: 15_000 })
    ));
  }

  const latencies = samples.map((sample) => sample.latencyMs);
  expect(latencies.every((latency) => Number.isFinite(latency) && latency >= 0)).toBe(true);
  const result = {
    generatedAt: new Date().toISOString(),
    execution: "synthetic local Chromium test using the isolated E2E Worker; not a production or 90-minute load test",
    clients: IDENTITIES.length,
    concurrentlyMutatingClients: IDENTITIES.length,
    rounds,
    sampleCount: samples.length,
    metric: "server command processedAt ACK timestamp to peer textarea DOM observation",
    eventTimestampCaveat: "processedAt is generated in the transaction after writes and immediately before transaction return; this local estimate is slightly earlier than commit and is therefore conservative",
    targetMs: 500,
    p50Ms: Number(percentile(latencies, 0.5).toFixed(1)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    maxMs: Number(Math.max(...latencies).toFixed(1)),
    targetMet: percentile(latencies, 0.95) < 500,
    samples
  };
  const reportPath = resolve(process.cwd(), ".tmp/15-client-performance-report.json");
  await mkdir(resolve(process.cwd(), ".tmp"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`15-client latency: ${JSON.stringify({ p50Ms: result.p50Ms, p95Ms: result.p95Ms, maxMs: result.maxMs, sampleCount: result.sampleCount })}`);
  expect(result.sampleCount).toBe(IDENTITIES.length * rounds);
  expect(result.p95Ms).toBeLessThan(500);
});
