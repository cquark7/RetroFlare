import type { Page } from "@playwright/test";
import { GetRetroDataSchema, ApiSuccessSchema, SingleRetroBackupDocumentSchema } from "../../src/shared/api";
import { LIMITS } from "../../src/shared/constants";
import { test, expect, createBoard, joinBoard, openBoard, addCard, card, cardField, saveCard, boardMenu, assertNoOverflow, type Actor } from "./fixtures";

test.setTimeout(60_000);

async function snapshot(actor: Actor, id: string) {
  const response = await actor.context.request.get(`/api/retros/${id}`);
  expect(response.ok()).toBe(true);
  return ApiSuccessSchema(GetRetroDataSchema).parse(await response.json()).data.retro;
}

function message(frame: string | Buffer): Record<string, unknown> {
  return JSON.parse(String(frame)) as Record<string, unknown>;
}

async function transferCaptain(page: Page, name: string) {
  const menu = await boardMenu(page);
  await menu.getByLabel("Transfer captain responsibility").selectOption({ label: name });
}

test("collaborators edit and react, and assign actions", async ({ actor }) => {
  const alex = await actor("user-01");
  const board = await createBoard(alex.page, "Collaboration");
  const [sam, jordan] = await Promise.all([actor("sam"), actor("jordan")]);
  await Promise.all([joinBoard(sam.page, board, "Sam Patel"), joinBoard(jordan.page, board, "Jordan Lee")]);
  await alex.page.locator(".participants-details > summary").click();
  await expect(alex.page.locator('.person-name[aria-label^="Sam Patel,"]')).toBeVisible();
  await expect(alex.page.locator('.person-name[aria-label^="Jordan Lee,"]')).toBeVisible();

  const thought = await addCard(alex.page);
  await expect(cardField(sam.page, thought.id)).toHaveValue("");
  await expect(cardField(sam.page, thought.id)).toHaveAttribute("readonly", "");
  await expect(card(sam.page, thought.id).getByRole("button", { name: "Delete this card" })).toHaveCount(0);
  await saveCard(alex.page, thought.id, "Pairing made the release calmer.");
  await expect(cardField(sam.page, thought.id)).toHaveValue("Pairing made the release calmer.");
  await card(sam.page, thought.id).getByRole("button", { name: "Add a reaction" }).click();
  await card(sam.page, thought.id).getByRole("button", { name: "Thumbs up", exact: true }).click();
  await expect(card(sam.page, thought.id).getByRole("button", { name: /^Thumbs up/ })).toHaveAttribute("aria-pressed", "true");
  await expect(card(alex.page, thought.id).getByRole("button", { name: "Thumbs up, 1 reaction", exact: true })).toBeVisible();

  await sam.page.getByRole("button", { name: /^Action items/ }).click();
  const action = await addCard(sam.page, "actions");
  await saveCard(sam.page, action.id, "Write the pairing checklist.");
  const owner = card(sam.page, action.id).getByLabel("Action owner name");
  await owner.fill("Taylor Kim");
  await owner.press("Tab");
  await expect.poll(async () => (await snapshot(sam, board.id)).cards[action.id]?.actionOwnerName).toBe("Taylor Kim");
  await alex.page.getByRole("button", { name: /^Action items/ }).click();
  await expect(alex.page.getByRole("dialog", { name: "Action items", exact: true }).getByText("Taylor Kim", { exact: true })).toBeVisible();
  await alex.page.getByRole("button", { name: "Close dialog" }).click();
  await transferCaptain(alex.page, "Sam Patel");
  await expect(sam.page.getByRole("button", { name: "Finish retro" })).toBeVisible();
  await expect(alex.page.getByRole("button", { name: "Finish retro" })).toHaveCount(0);
  const saved = await snapshot(alex, board.id);
  expect(saved.cards[action.id]?.actionOwnerName).toBe("Taylor Kim");
  await alex.page.reload();
  await expect(alex.page.locator(".connection-note--online")).toBeVisible();
  await expect(cardField(alex.page, thought.id)).toHaveValue("Pairing made the release calmer.");
  await expect(card(alex.page, thought.id).getByRole("button", { name: "Thumbs up, 1 reaction", exact: true })).toBeVisible();
  await alex.page.getByRole("button", { name: /^Action items/ }).click();
  await expect(alex.page.getByRole("dialog", { name: "Action items", exact: true }).getByText("Taylor Kim", { exact: true })).toBeVisible();
});

test("continuous typing syncs before blur and Enter saves while Shift+Enter inserts a line", async ({ actor }) => {
  const alex = await actor("user-02");
  let cardId = "";
  let firstUpdate: { text: string; at: number } | undefined;
  alex.page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const commands = message(payload).commands as { type: string; payload: { cardId?: string; text?: string } }[] | undefined;
    for (const command of commands ?? []) {
      if (command.type === "card.update" && command.payload.cardId === cardId && !firstUpdate) {
        firstUpdate = { text: command.payload.text!, at: Date.now() };
      }
    }
  }));
  const board = await createBoard(alex.page, "Live typing");
  const sam = await actor("sam");
  await joinBoard(sam.page, board, "Sam Patel");
  const thought = await addCard(alex.page);
  cardId = thought.id;
  const peer = cardField(sam.page, thought.id);
  await expect(peer).toHaveValue("");
  const text = "Continuous typing reaches the team before blur. ".repeat(4);
  const field = cardField(alex.page, thought.id);
  const startedAt = Date.now();
  const typing = field.pressSequentially(text, { delay: 35, timeout: 20_000 });
  try {
    await expect.poll(() => firstUpdate, { timeout: 6_000, intervals: [50] }).toBeTruthy();
    expect(firstUpdate!.at - startedAt).toBeLessThanOrEqual(LIMITS.draftMaximumWaitMs);
    expect(firstUpdate!.text.length).toBeLessThan(text.length);
    await expect(peer).not.toHaveValue("");
    await expect(field).toBeFocused();
    await expect(card(sam.page, thought.id).locator(".card-typing-indicator")).toContainText("Alex Morgan typing…");
  } finally {
    await typing;
  }
  await field.press("Shift+Enter");
  await field.pressSequentially("A second line.");
  await expect(field).toHaveValue(`${text}\nA second line.`);
  await field.press("Enter");
  await expect(field).not.toBeFocused();
  await expect(peer).toHaveValue(`${text}\nA second line.`);
  await expect(card(alex.page, thought.id).locator(".save-state")).toHaveText("Saved");
  await expect(card(sam.page, thought.id).locator(".card-typing-indicator")).toHaveCount(0);
  await card(alex.page, thought.id).getByRole("button", { name: "Add a reaction" }).click();
  await expect(card(alex.page, thought.id).locator(".reaction-picker")).toBeVisible();
});

test("offline drafts survive reconnect and synchronize to a collaborator", async ({ actor }) => {
  const alex = await actor("user-03");
  const board = await createBoard(alex.page, "Offline recovery");
  const sam = await actor("sam");
  await joinBoard(sam.page, board, "Sam Patel");
  const thought = await addCard(alex.page);
  await saveCard(alex.page, thought.id, "Original saved thought.");
  await expect(cardField(sam.page, thought.id)).toHaveValue("Original saved thought.");
  await alex.context.setOffline(true);
  await cardField(alex.page, thought.id).fill("A draft written offline.");
  await expect(alex.page.locator(".connection-note--offline")).toBeVisible();
  await expect.poll(() => alex.page.evaluate(() => Object.keys(sessionStorage)
    .filter((key) => key.startsWith("retroflare:draft:"))
    .some((key) => sessionStorage.getItem(key)?.includes("A draft written offline.")))).toBe(true);
  await expect(cardField(sam.page, thought.id)).toHaveValue("Original saved thought.");
  await alex.context.setOffline(false);
  await expect(alex.page.locator(".connection-note--online")).toBeVisible({ timeout: 20_000 });
  await expect(card(alex.page, thought.id).locator(".save-state")).toHaveText("Saved");
  await expect(cardField(sam.page, thought.id)).toHaveValue("A draft written offline.");
  await alex.page.reload();
  await expect(cardField(alex.page, thought.id)).toHaveValue("A draft written offline.");
});

test("same-actor tabs preserve a conflicting draft until an explicit choice", async ({ actor }) => {
  const alex = await actor("user-04");
  const board = await createBoard(alex.page, "Tab conflict");
  const thought = await addCard(alex.page);
  await saveCard(alex.page, thought.id, "Initial text.");
  // Tabs share authentication/storage like a real second tab, with tab-local drafts.
  const secondPage = await alex.context.newPage();
  await openBoard(secondPage, board);
  // Hold both tabs offline while authoring so both drafts use the same saved version.
  await alex.context.setOffline(true);
  await Promise.all([cardField(alex.page, thought.id).fill("First tab draft."), cardField(secondPage, thought.id).fill("Second tab draft.")]);
  await Promise.all([alex.page, secondPage].map((page) => expect(page.locator(".connection-note--offline")).toBeVisible()));
  await alex.context.setOffline(false);
  await expect.poll(async () => (await alex.page.locator(".conflict-panel").count()) + (await secondPage.locator(".conflict-panel").count()), { timeout: 20_000 }).toBe(1);
  const conflictPage = await alex.page.locator(".conflict-panel").count() ? alex.page : secondPage;
  const retained = await cardField(conflictPage, thought.id).inputValue();
  await expect(card(conflictPage, thought.id).getByText("This card was saved differently in another tab.")).toBeVisible();
  await card(conflictPage, thought.id).getByRole("button", { name: "Use my draft" }).click();
  await expect(conflictPage.locator(".conflict-panel")).toHaveCount(0);
  await expect(cardField(alex.page, thought.id)).toHaveValue(retained);
  await expect(cardField(secondPage, thought.id)).toHaveValue(retained);
  expect((await snapshot(alex, board.id)).cards[thought.id]?.text).toBe(retained);
});

test("a persisted update retries a lost ACK without applying the mutation twice", async ({ actor }) => {
  const alex = await actor("user-05");
  const board = await createBoard(alex.page, "Lost ACK");
  const thought = await addCard(alex.page);
  await saveCard(alex.page, thought.id, "Before lost ACK.");
  const before = await snapshot(alex, board.id);
  let updateId = "";
  let dropped = false;
  let duplicate = false;
  const sentIds: string[] = [];
  await alex.context.routeWebSocket((url) => url.pathname === `/api/retros/${board.id}/ws`, (client) => {
    const server = client.connectToServer();
    client.onMessage((frame) => {
      const commands = message(frame).commands as { type: string; commandId: string }[] | undefined;
      for (const command of commands ?? []) if (command.type === "card.update") {
        updateId ||= command.commandId;
        sentIds.push(command.commandId);
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      const incoming = message(frame);
      if (incoming.type === "ack" && incoming.commandId === updateId) {
        if (!dropped) {
          dropped = true;
          client.close({ code: 1011, reason: "Test: persisted ACK lost" });
          server.close();
          return;
        }
        duplicate = incoming.duplicate === true;
      }
      client.send(frame);
    });
  });
  await alex.page.reload();
  await expect(alex.page.locator(".connection-note--online")).toBeVisible();
  await cardField(alex.page, thought.id).fill("Accepted exactly once.");
  await cardField(alex.page, thought.id).press("Enter");
  await expect.poll(() => dropped).toBe(true);
  await expect.poll(() => duplicate, { timeout: 20_000 }).toBe(true);
  await expect(card(alex.page, thought.id).locator(".save-state")).toHaveText("Saved");
  expect(sentIds.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sentIds).size).toBe(1);
  const after = await snapshot(alex, board.id);
  expect(after.cards[thought.id]?.text).toBe("Accepted exactly once.");
  expect(after.cards[thought.id]?.version).toBe(before.cards[thought.id]!.version + 1);
});

test("a missing revision triggers a fresh snapshot and boards stay isolated", async ({ actor }) => {
  const alex = await actor("user-06");
  const board = await createBoard(alex.page, "Revision recovery");
  const thought = await addCard(alex.page);
  await saveCard(alex.page, thought.id, "Initial text.");
  const sam = await actor("sam");
  await joinBoard(sam.page, board, "Sam Patel");
  let droppedRevision = 0;
  let snapshots = 0;
  const receivedBoards: string[] = [];
  await sam.context.routeWebSocket((url) => url.pathname === `/api/retros/${board.id}/ws`, (client) => {
    const server = client.connectToServer();
    client.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      const incoming = message(frame);
      if (incoming.type === "snapshot") snapshots += 1;
      if (incoming.type === "events") {
        receivedBoards.push(incoming.retroId as string);
        const events = incoming.events as { type: string; cardId?: string; text?: string; revision: number }[];
        const target = events.find((event) => event.type === "card.updated" && event.cardId === thought.id && event.text === "Dropped revision.");
        if (target && !droppedRevision) { droppedRevision = target.revision; return; }
      }
      client.send(frame);
    });
  });
  await sam.page.reload();
  await expect.poll(() => snapshots).toBe(1);
  await saveCard(alex.page, thought.id, "Dropped revision.");
  await expect.poll(() => droppedRevision).toBeGreaterThan(0);
  await expect(cardField(sam.page, thought.id)).toHaveValue("Initial text.");
  await saveCard(alex.page, thought.id, "Recovered revision.");
  await expect.poll(() => snapshots).toBeGreaterThan(1);
  await expect(cardField(sam.page, thought.id)).toHaveValue("Recovered revision.");

  const jordan = await actor("jordan");
  const isolated = await createBoard(jordan.page, "Isolated board", "Jordan Lee");
  const other = await addCard(jordan.page);
  await saveCard(jordan.page, other.id, "Only on the isolated board.");
  // A same-room acknowledged mutation is a delivery barrier, rather than a sleep.
  await saveCard(alex.page, thought.id, "Isolation delivery barrier.");
  await expect(cardField(sam.page, thought.id)).toHaveValue("Isolation delivery barrier.");
  expect(receivedBoards).not.toContain(isolated.id);
  await expect(cardField(sam.page, other.id)).toHaveCount(0);
  expect((await snapshot(sam, board.id)).cards).not.toHaveProperty(other.id);
});

test("finish gathers a participant draft, preserves read-only history, and round-trips export/import", async ({ actor }) => {
  const alex = await actor("alex");
  let socketCount = 0;
  alex.page.on("websocket", (socket) => { if (socket.url().includes("/api/retros/")) socketCount += 1; });
  const board = await createBoard(alex.page, "Completed history");
  expect(socketCount, "Creating a board must open exactly one connection, including under StrictMode").toBe(1);
  const sam = await actor("sam");
  await joinBoard(sam.page, board, "Sam Patel");
  const thought = await addCard(sam.page);
  await saveCard(sam.page, thought.id, "Saved before closing.");
  await expect(cardField(alex.page, thought.id)).toHaveValue("Saved before closing.");
  await cardField(sam.page, thought.id).fill("Participant’s final draft.");
  await expect(cardField(sam.page, thought.id)).toBeFocused();
  await expect(card(sam.page, thought.id).locator(".save-state")).not.toHaveText("Saved");
  await expect(cardField(alex.page, thought.id)).toHaveValue("Saved before closing.");
  await alex.page.getByRole("button", { name: "Finish retro" }).click();
  await alex.page.getByRole("button", { name: "Prepare to finish" }).click();
  await Promise.all([alex.page, sam.page].map((page) => expect(page.locator(".board-heading .status-tag")).toHaveText("Completed", { timeout: 20_000 })));
  const closed = await snapshot(alex, board.id);
  expect(closed.status).toBe("closed");
  expect(closed.cards[thought.id]?.text).toBe("Participant’s final draft.");
  await sam.page.reload();
  await expect(cardField(sam.page, thought.id)).toHaveValue("Participant’s final draft.");
  await expect(cardField(sam.page, thought.id)).toHaveAttribute("readonly", "");
  await expect(sam.page.locator(".connection-note")).toContainText("Read-only history");
  await expect(sam.page.getByRole("button", { name: "Add a card" })).toHaveCount(0);
  await boardMenu(alex.page);
  const downloadPromise = alex.page.waitForEvent("download");
  await alex.page.getByRole("button", { name: "Export board" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Export download stream unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  const buffer = Buffer.concat(chunks);
  const backup = SingleRetroBackupDocumentSchema.parse(JSON.parse(buffer.toString("utf8")));
  expect(download.suggestedFilename()).toMatch(/^completed-history-.*\.json$/);
  expect(backup.format).toBe("retroflare-backup");
  expect(backup.retros).toHaveLength(1);
  expect(backup.retros[0]!.cards[thought.id]?.text).toBe("Participant’s final draft.");
  await boardMenu(alex.page);
  const markdownPromise = alex.page.waitForEvent("download");
  await alex.page.getByRole("button", { name: "Download as Markdown" }).click();
  const markdownDownload = await markdownPromise;
  expect(markdownDownload.suggestedFilename()).toMatch(/\.md$/);
  const markdownStream = await markdownDownload.createReadStream();
  if (!markdownStream) throw new Error("Markdown download stream unavailable");
  const markdownChunks: Buffer[] = [];
  for await (const chunk of markdownStream) markdownChunks.push(Buffer.from(chunk as Uint8Array));
  const markdown = Buffer.concat(markdownChunks).toString("utf8");
  expect(markdown).toContain(`# ${board.title}`);
  expect(markdown).toContain("- **Team:** Alex Morgan");
  expect(markdown).toContain("- **Participants:** Alex Morgan, Sam Patel");
  expect(markdown).toContain("**Sam Patel:** Participant’s final draft");
  await alex.page.getByRole("button", { name: /All retros/ }).click();
  await alex.page.getByRole("button", { name: "Import backup" }).click();
  const legacyBuffer = Buffer.from(JSON.stringify({ ...backup, format: "siq-retro-backup" }));
  await alex.page.getByLabel("Backup JSON file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: legacyBuffer });
  await alex.page.getByRole("button", { name: "Preview import" }).click();
  await expect(alex.page.getByText("0 to add", { exact: true })).toBeVisible();
  await expect(alex.page.getByText("1 already present", { exact: true })).toBeVisible();
  await alex.page.getByRole("checkbox", { name: /I understand this adds completed history only/ }).check();
  await alex.page.getByRole("button", { name: "Add completed history" }).click();
  await expect(alex.page.getByText("History is ready in the completed list.")).toBeVisible();
  await alex.page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(alex.page.locator(".summary-list--history .retro-summary__title").filter({ hasText: board.title })).toHaveCount(1);
  for (const width of [390, 320]) {
    await alex.page.setViewportSize({ width, height: 844 });
    await assertNoOverflow(alex.page);
  }
});

test("home and a populated board support keyboard focus and narrow screens", async ({ actor }) => {
  const alex = await actor("user-08");
  await alex.page.keyboard.press("Tab");
  const focus = await alex.page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(focus.style).toBe("solid");
  // The current theme uses a 2px keyboard-focus outline.
  expect(focus.width).toBeGreaterThanOrEqual(2);
  const board = await createBoard(alex.page, "Responsive board");
  const thought = await addCard(alex.page);
  await saveCard(alex.page, thought.id, "A practical note with a long URL: https://example.com/" + "a".repeat(120));
  const moveHandle = card(alex.page, thought.id).getByRole("button", { name: "Drag to move Alex Morgan’s card" });
  for (const width of [390, 320]) {
    await alex.page.setViewportSize({ width, height: 844 });
    await assertNoOverflow(alex.page);
    await expect(alex.page.getByRole("heading", { name: board.title, exact: true })).toBeVisible();
    const bounds = await moveHandle.boundingBox();
    expect(bounds?.width).toBeGreaterThanOrEqual(40);
    expect(bounds?.height).toBeGreaterThanOrEqual(40);
  }
});
