import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BackupDocumentSchema } from "../src/shared/backup";
import { BACKUP_EXPORT_VERSION, PROTOCOL_VERSION, RETRO_SCHEMA_VERSION } from "../src/shared/constants";
import { AuthPrincipalSchema } from "../src/shared/auth";
import type { AuthPrincipal } from "../src/shared/auth";
import { compareCardsInColumnOrder, type Retro } from "../src/shared/domain";
import { createLocalDevelopmentPrincipal } from "../worker/auth/local-development";
import { migrateStoredRetro } from "../worker/storage";
import { parseBackupPreviewBody } from "../worker/backups";
import { makeRetro } from "./fixtures";

const localEnvironment = {
  DEV_AUTH: "enabled",
  DEV_DEFAULT_IDENTITY: "alex",
  DEV_ADMIN_IDENTITY: "alex",
  APP_ORIGIN: "http://localhost:5173"
};

type ApiSuccess<T> = { ok: true; requestId: string; data: T };

async function principal(identity = "alex"): Promise<AuthPrincipal> {
  return (await createLocalDevelopmentPrincipal(localEnvironment, identity))!;
}

function teamStub(name = `backend-${crypto.randomUUID()}`): DurableObjectStub {
  const bindings = env as unknown as Env;
  return bindings.TEAM_RETRO.get(bindings.TEAM_RETRO.idFromName(name));
}

function requestFor(
  actor: AuthPrincipal,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Request {
  const headers = new Headers(init.headers);
  headers.set("x-retroflare-principal", JSON.stringify(actor));
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://team-retro.test${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
}

async function api<T>(
  stub: DurableObjectStub,
  actor: AuthPrincipal,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ response: Response; body: ApiSuccess<T> | { ok: false; error: unknown } }> {
  const response = await stub.fetch(requestFor(actor, path, init));
  return { response, body: await response.json() as ApiSuccess<T> | { ok: false; error: unknown } };
}

function command(type: string, payload: Record<string, unknown>, commandId = crypto.randomUUID()) {
  return { protocolVersion: PROTOCOL_VERSION, commandId, type, payload };
}

async function createRetro(stub: DurableObjectStub, actor: AuthPrincipal, title = "Runtime retro") {
  const result = await api<{ retro: Retro }>(stub, actor, "/api/retros", {
    method: "POST",
    body: { title, displayName: actor.email.split("@")[0] }
  });
  expect(result.response.status).toBe(200);
  if (!result.body.ok) throw new Error("Retro creation failed.");
  return result.body.data.retro;
}

async function runCommands(
  stub: DurableObjectStub,
  actor: AuthPrincipal,
  retroId: string,
  commands: unknown[]
) {
  return api<{ acceptedCommandIds: string[]; resultingRevision: number }>(
    stub,
    actor,
    `/api/retros/${retroId}/commands`,
    { method: "POST", body: { protocolVersion: PROTOCOL_VERSION, commands } }
  );
}

describe("TeamRetro Durable Object runtime", () => {
  it("persists boards, rejects unauthorized edits atomically, and accepts concurrent edits to separate cards", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const sam = await principal("sam");
    const retro = await createRetro(stub, alex);
    const retroId = retro.id;

    await api(stub, sam, `/api/retros/${retroId}/join`, {
      method: "POST",
      body: { displayName: "Sam" }
    });
    const firstCardId = crypto.randomUUID();
    const secondCardId = crypto.randomUUID();
    await runCommands(stub, alex, retroId, [
      command("card.create", { cardId: firstCardId, columnId: "went-well", text: "First" })
    ]);
    await runCommands(stub, sam, retroId, [
      command("card.create", { cardId: secondCardId, columnId: "could-improve", text: "Second" })
    ]);

    const denied = await runCommands(stub, sam, retroId, [
      command("card.update", { cardId: firstCardId, text: "Should not persist", expectedCardVersion: 1 })
    ]);
    expect(denied.response.status).toBe(403);
    if (denied.body.ok) throw new Error("A non-author edit was accepted.");
    expect((denied.body.error as { code: string }).code).toBe("FORBIDDEN");

    const sameCardEdits = await Promise.all([
      runCommands(stub, alex, retroId, [
        command("card.update", { cardId: firstCardId, text: "Competing draft A", expectedCardVersion: 1 })
      ]),
      runCommands(stub, alex, retroId, [
        command("card.update", { cardId: firstCardId, text: "Competing draft B", expectedCardVersion: 1 })
      ])
    ]);
    expect(sameCardEdits.map(({ response }) => response.status).sort()).toEqual([200, 409]);

    const edits = await Promise.all([
      runCommands(stub, alex, retroId, [
        command("card.update", { cardId: firstCardId, text: "First updated", expectedCardVersion: 2 })
      ]),
      runCommands(stub, sam, retroId, [
        command("card.update", { cardId: secondCardId, text: "Second updated", expectedCardVersion: 1 })
      ])
    ]);
    expect(edits.map(({ response }) => response.status)).toEqual([200, 200]);

    const reloaded = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    expect(reloaded.body.ok).toBe(true);
    if (!reloaded.body.ok) throw new Error("The persisted retro could not be read.");
    expect(reloaded.body.data.retro.cards[firstCardId]?.text).toBe("First updated");
    expect(reloaded.body.data.retro.cards[secondCardId]?.text).toBe("Second updated");
    expect(reloaded.body.data.retro.revision).toBe(7);

    const page = await api<{ retros: { id: string; title: string }[]; hasMore: boolean }>(
      stub,
      alex,
      "/api/retros"
    );
    expect(page.body.ok && page.body.data.retros[0]?.id).toBe(retroId);
  });

  it("persists authorized card order, appends new cards, and rejects stale or multi-card reorder requests", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const sam = await principal("sam");
    const retro = await createRetro(stub, alex, "Card ordering");
    await api(stub, sam, `/api/retros/${retro.id}/join`, {
      method: "POST",
      body: { displayName: "Sam" }
    });

    const firstCardId = "00000000-0000-4000-8000-000000000010";
    const secondCardId = "00000000-0000-4000-8000-000000000011";
    const thirdCardId = "00000000-0000-4000-8000-000000000012";
    await runCommands(stub, alex, retro.id, [
      command("card.create", { cardId: firstCardId, columnId: "went-well", text: "First thought" })
    ]);
    await runCommands(stub, sam, retro.id, [
      command("card.create", { cardId: secondCardId, columnId: "went-well", text: "Second thought" })
    ]);
    const beforeReorder = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!beforeReorder.body.ok) throw new Error("The retro could not be read before reordering.");

    const unauthorized = await runCommands(stub, sam, retro.id, [command("card.reorder", {
      cardId: firstCardId,
      columnId: "went-well",
      orderedCardIds: [secondCardId, firstCardId],
      expectedRetroRevision: beforeReorder.body.data.retro.revision
    })]);
    expect(unauthorized.response.status).toBe(403);

    const reorder = await runCommands(stub, alex, retro.id, [command("card.reorder", {
      cardId: secondCardId,
      columnId: "went-well",
      orderedCardIds: [secondCardId, firstCardId],
      expectedRetroRevision: beforeReorder.body.data.retro.revision
    })]);
    expect(reorder.response.status).toBe(200);
    const ordered = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!ordered.body.ok) throw new Error("The retro could not be read after reordering.");
    expect(ordered.body.data.retro.cards[secondCardId]?.sortOrder).toBe(0);
    expect(ordered.body.data.retro.cards[firstCardId]?.sortOrder).toBe(1);

    await runCommands(stub, alex, retro.id, [
      command("card.create", { cardId: thirdCardId, columnId: "went-well", text: "Third thought" })
    ]);
    const afterAppend = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!afterAppend.body.ok) throw new Error("The retro could not be read after adding a card.");
    expect(afterAppend.body.data.retro.cards[thirdCardId]?.sortOrder).toBe(2);

    const stale = await runCommands(stub, alex, retro.id, [command("card.reorder", {
      cardId: secondCardId,
      columnId: "went-well",
      orderedCardIds: [firstCardId, secondCardId, thirdCardId],
      expectedRetroRevision: ordered.body.data.retro.revision
    })]);
    expect(stale.response.status).toBe(409);

    const unauthorizedMultiCard = await runCommands(stub, sam, retro.id, [command("card.reorder", {
      cardId: secondCardId,
      columnId: "went-well",
      orderedCardIds: [secondCardId, thirdCardId, firstCardId],
      expectedRetroRevision: afterAppend.body.data.retro.revision
    })]);
    expect(unauthorizedMultiCard.response.status).toBe(400);
    const final = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!final.body.ok) throw new Error("The retro could not be read after rejected reorder requests.");
    expect([
      final.body.data.retro.cards[secondCardId]?.sortOrder,
      final.body.data.retro.cards[firstCardId]?.sortOrder,
      final.body.data.retro.cards[thirdCardId]?.sortOrder
    ]).toEqual([0, 1, 2]);
  });

  it("binds deduplication to actor and payload and enforces absolute desired-state reactions", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const sam = await principal("sam");
    const retro = await createRetro(stub, alex, "Dedup and votes");
    const retroId = retro.id;
    await api(stub, sam, `/api/retros/${retroId}/join`, {
      method: "POST",
      body: { displayName: "Sam" }
    });
    const cards = Array.from({ length: 4 }, () => crypto.randomUUID());
    const firstCreate = command(
      "card.create",
      { cardId: cards[0], columnId: "went-well", text: "Stable card" }
    );
    await runCommands(stub, alex, retroId, [firstCreate]);
    const firstSnapshot = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!firstSnapshot.body.ok) throw new Error("The retro could not be read.");
    const afterFirstCreate = firstSnapshot.body.data.retro.revision;

    const duplicate = await runCommands(stub, alex, retroId, [firstCreate]);
    expect(duplicate.response.status).toBe(200);
    const sameIdDifferentActor = await runCommands(stub, sam, retroId, [firstCreate]);
    expect(sameIdDifferentActor.response.status).toBe(409);
    const afterDuplicate = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!afterDuplicate.body.ok) throw new Error("The retro could not be read.");
    expect(afterDuplicate.body.data.retro.revision).toBe(afterFirstCreate);

    await runCommands(stub, alex, retroId, cards.slice(1).map((cardId) =>
      command("card.create", { cardId, columnId: "could-improve", text: "Vote candidate" })
    ));
    const voteCommands = cards.slice(0, 3).map((cardId) => command("reaction.set", { cardId, emoji: "👍", reacted: true }));
    for (const vote of voteCommands) {
      expect((await runCommands(stub, sam, retroId, [vote])).response.status).toBe(200);
    }
    const beforeNoop = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!beforeNoop.body.ok) throw new Error("The retro could not be read.");
    const noop = await runCommands(stub, sam, retroId, [
      command("reaction.set", { cardId: cards[0], emoji: "👍", reacted: true })
    ]);
    expect(noop.response.status).toBe(200);
    const beforeLimit = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!beforeLimit.body.ok) throw new Error("The retro could not be read.");
    expect(beforeLimit.body.data.retro.revision).toBe(beforeNoop.body.data.retro.revision);

    const overLimit = await runCommands(stub, sam, retroId, [
      command("reaction.set", { cardId: cards[3], emoji: "👍", reacted: true })
    ]);
    expect(overLimit.response.status).toBe(200);
    const finalSnapshot = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!finalSnapshot.body.ok) throw new Error("The retro could not be read.");
    expect(finalSnapshot.body.data.retro.reactions[sam.actorId]).toHaveLength(4);
    expect((await runCommands(stub, sam, retroId, [command("reaction.set", { cardId: cards[0], emoji: "💡", reacted: true })])).response.status).toBe(200);
    expect((await runCommands(stub, sam, retroId, [command("reaction.set", { cardId: cards[0], emoji: "👍", reacted: false })])).response.status).toBe(200);
    const shoutoutId = crypto.randomUUID();
    const createShoutout = await runCommands(stub, alex, retroId, [
      command("card.create", { cardId: shoutoutId, columnId: "shoutouts", text: "Thanks for the thoughtful review." })
    ]);
    expect(createShoutout.response.status).toBe(200);
    const voteOnShoutout = await runCommands(stub, sam, retroId, [
      command("reaction.set", { cardId: shoutoutId, emoji: "🎉", reacted: true })
    ]);
    expect(voteOnShoutout.response.status).toBe(200);
    const moveIntoShoutouts = await runCommands(stub, alex, retroId, [
      command("card.move", { cardId: cards[1], columnId: "shoutouts", expectedCardVersion: 1 })
    ]);
    expect(moveIntoShoutouts.response.status).toBe(200);
    const movedToShoutouts = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!movedToShoutouts.body.ok) throw new Error("The Shoutouts card could not be read after a move.");
    expect(movedToShoutouts.body.data.retro.cards[cards[1]]?.columnId).toBe("shoutouts");
    expect(movedToShoutouts.body.data.retro.reactions[sam.actorId]).toContainEqual({ cardId: cards[1], emoji: "👍" });

    const moveIntoActions = await runCommands(stub, alex, retroId, [
      command("card.move", { cardId: cards[2], columnId: "actions", expectedCardVersion: 1 })
    ]);
    expect(moveIntoActions.response.status).toBe(409);
    const moved = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!moved.body.ok) throw new Error("The retro could not be read after a card move.");
    expect(moved.body.data.retro.cards[cards[2]]?.columnId).toBe("could-improve");
    expect(moved.body.data.retro.reactions[sam.actorId]).toContainEqual({ cardId: cards[2], emoji: "👍" });
    const actionId = crypto.randomUUID();
    await runCommands(stub, alex, retroId, [command("card.create", { cardId: actionId, columnId: "actions", text: "Follow up" })]);
    expect((await runCommands(stub, sam, retroId, [command("reaction.set", { cardId: actionId, emoji: "🚀", reacted: true })])).response.status).toBe(200);
    expect((await runCommands(stub, alex, retroId, [command("card.delete", { cardId: actionId, expectedCardVersion: 1 })])).response.status).toBe(200);
    const deleted = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retroId}`);
    if (!deleted.body.ok) throw new Error("Could not read board after delete.");
    expect(deleted.body.data.retro.reactions[sam.actorId]?.some((entry) => entry.cardId === actionId)).toBe(false);
  });

  it("exports raw and empty backups, previews append-only imports, and preserves non-conflicting boards in a collision batch", async () => {
    const source = teamStub();
    const target = teamStub();
    const alex = await principal("alex");
    const sam = await principal("sam");
    const retro = await createRetro(source, alex, "Portable history");
    await api(source, sam, `/api/retros/${retro.id}/join`, {
      method: "POST",
      body: { displayName: "Sam" }
    });
    const cardId = crypto.randomUUID();
    const secondCardId = crypto.randomUUID();
    await runCommands(source, alex, retro.id, [
      command("card.create", { cardId, columnId: "went-well", text: "Preserved history" })
    ]);
    await runCommands(source, alex, retro.id, [
      command("card.create", { cardId: secondCardId, columnId: "went-well", text: "A second thought" })
    ]);
    const beforeReorder = await api<{ retro: Retro }>(source, alex, `/api/retros/${retro.id}`);
    if (!beforeReorder.body.ok) throw new Error("The retro could not be read before export ordering.");
    const originalOrder = Object.values(beforeReorder.body.data.retro.cards)
      .filter((card) => card.columnId === "went-well")
      .sort(compareCardsInColumnOrder)
      .map((card) => card.id);
    const reorderedCardIds = [...originalOrder].reverse();
    const reorder = await runCommands(source, alex, retro.id, [command("card.reorder", {
      cardId: originalOrder[0],
      columnId: "went-well",
      orderedCardIds: reorderedCardIds,
      expectedRetroRevision: beforeReorder.body.data.retro.revision
    })]);
    expect(reorder.response.status).toBe(200);
    await runCommands(source, sam, retro.id, [command("reaction.set", { cardId, emoji: "👍", reacted: true })]);

    const singleExport = await source.fetch(requestFor(alex, `/api/retros/${retro.id}/export`));
    expect(singleExport.headers.get("Content-Disposition")).toBe(`attachment; filename="retroflare-${retro.id}.json"`);
    const backup = BackupDocumentSchema.parse(await singleExport.json());
    expect(backup.retros).toHaveLength(1);
    expect(backup.exportVersion).toBe(BACKUP_EXPORT_VERSION);
    expect(backup.format).toBe("retroflare-backup");
    expect(Object.values(backup.retros[0]!.cards).filter((card) => card.columnId === "went-well")
      .sort(compareCardsInColumnOrder).map((card) => card.id)).toEqual(reorderedCardIds);
    const allExport = await source.fetch(requestFor(alex, "/api/export"));
    expect(allExport.headers.get("Content-Disposition")).toBe('attachment; filename="retroflare-backup.json"');
    expect(BackupDocumentSchema.parse(await allExport.json()).retros).toHaveLength(1);
    const pagedExport = await source.fetch(requestFor(alex, "/api/export?pageSize=1"));
    const pagedBody = await pagedExport.json() as { ok: boolean; data: { retros: Retro[] } };
    expect(pagedBody.ok).toBe(true);
    expect(pagedBody.data.retros).toHaveLength(1);

    const empty = await teamStub();
    const emptyBackupResponse = await empty.fetch(requestFor(alex, "/api/export"));
    expect(BackupDocumentSchema.parse(await emptyBackupResponse.json()).retros).toEqual([]);

    const nonAdminPreview = await api<unknown>(target, sam, "/api/import/preview", {
      method: "POST",
      body: { backup }
    });
    expect(nonAdminPreview.response.status).toBe(403);
    const unsupportedImport = await api<unknown>(target, alex, "/api/import/preview", {
      method: "POST",
      body: { backup: { ...backup, exportVersion: 99 } }
    });
    expect(unsupportedImport.response.status).toBe(400);

    const preview = await api<{
      previewId: string;
      report: { createCount: number; conflictCount: number; batchCount: number };
    }>(target, alex, "/api/import/preview", { method: "POST", body: { backup } });
    expect(preview.response.status).toBe(200);
    if (!preview.body.ok) throw new Error("Import preview failed.");
    expect(preview.body.data.report).toMatchObject({ createCount: 1, conflictCount: 0, batchCount: 1 });
    const imported = await api<{ completedBatchCount: number; batches: { status: string }[] }>(
      target,
      alex,
      "/api/import",
      {
        method: "POST",
        body: {
          backup,
          previewId: preview.body.data.previewId,
          confirmation: "append-only-import"
        }
      }
    );
    expect(imported.response.status).toBe(200);
    expect(imported.body.ok && imported.body.data.batches[0]?.status).toBe("applied");
    const restored = await api<{ retro: Retro }>(target, alex, `/api/retros/${retro.id}`);
    if (!restored.body.ok) throw new Error("The imported retro could not be read.");
    expect(restored.body.data.retro).toMatchObject({
      status: "closed",
      importMetadata: { importedFromStatus: "open" },
      reactions: { [sam.actorId]: [{ cardId, emoji: "👍" }] }
    });
    expect(restored.body.data.retro.cards[cardId]?.text).toBe("Preserved history");
    expect(Object.values(restored.body.data.retro.cards).filter((card) => card.columnId === "went-well")
      .sort(compareCardsInColumnOrder).map((card) => card.id)).toEqual(reorderedCardIds);

    const duplicateImport = await api<{ batches: { status: string }[] }>(target, alex, "/api/import", {
      method: "POST",
      body: {
        backup,
        previewId: preview.body.data.previewId,
        confirmation: "append-only-import"
      }
    });
    expect(duplicateImport.body.ok && duplicateImport.body.data.batches[0]?.status).toBe("already-applied");

    const secondRetro = await createRetro(source, alex, "Should roll back with conflict");
    const firstHistoryPage = await api<{
      retros: { id: string }[];
      nextCursor?: string;
      hasMore: boolean;
    }>(source, alex, "/api/retros?pageSize=1");
    if (!firstHistoryPage.body.ok) throw new Error("History pagination failed.");
    expect(firstHistoryPage.body.data.hasMore).toBe(true);
    const secondHistoryPage = await api<{ retros: { id: string }[]; hasMore: boolean }>(
      source,
      alex,
      `/api/retros?pageSize=1&cursor=${encodeURIComponent(firstHistoryPage.body.data.nextCursor!)}`
    );
    expect(secondHistoryPage.body.ok && secondHistoryPage.body.data.retros[0]?.id).not.toBe(
      firstHistoryPage.body.data.retros[0]?.id
    );
    const collisionBackup = BackupDocumentSchema.parse({
      ...backup,
      retros: [
        { ...backup.retros[0]!, title: "Different content at same ID" },
        secondRetro
      ]
    });
    const conflictPreview = await api<{ previewId: string; report: { conflictCount: number } }>(
      target,
      alex,
      "/api/import/preview",
      { method: "POST", body: { backup: collisionBackup } }
    );
    if (!conflictPreview.body.ok) throw new Error("Conflict preview failed.");
    expect(conflictPreview.body.data.report.conflictCount).toBe(1);
    const importedAroundConflict = await api<{
      completedBatchCount: number;
      batches: { status: string; importedRetroIds: string[]; conflictingRetroIds: string[] }[];
    }>(target, alex, "/api/import", {
      method: "POST",
      body: {
        backup: collisionBackup,
        previewId: conflictPreview.body.data.previewId,
        confirmation: "append-only-import"
      }
    });
    expect(importedAroundConflict.body.ok && importedAroundConflict.body.data.batches[0]?.status).toBe("applied");
    expect(importedAroundConflict.body.ok && importedAroundConflict.body.data.batches[0]?.conflictingRetroIds).toEqual([retro.id]);
    expect(importedAroundConflict.body.ok && importedAroundConflict.body.data.batches[0]?.importedRetroIds).toEqual([secondRetro.id]);
    const importedAroundConflictBoard = await api<{ retro: Retro }>(target, alex, `/api/retros/${secondRetro.id}`);
    expect(importedAroundConflictBoard.body.ok && importedAroundConflictBoard.body.data.retro.importMetadata?.importedFromStatus).toBe("open");
    const unchanged = await api<{ retro: Retro }>(target, alex, `/api/retros/${retro.id}`);
    expect(unchanged.body.ok && unchanged.body.data.retro.title).toBe("Portable history");
  });

  it("previews a 10,000-retro backup without persisting its multi-megabyte report as one storage value", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const template = await createRetro(stub, alex, "Preview template");
    const retros = Array.from({ length: 10_000 }, (_, index) => ({
      ...template,
      id: crypto.randomUUID(),
      title: `${String(index).padStart(5, "0")}-${"x".repeat(114)}`
    }));
    const backup = BackupDocumentSchema.parse({
      format: "retroflare-backup",
      exportVersion: BACKUP_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      sourceApplicationVersion: "test",
      retros
    });
    const serialized = JSON.stringify(backup);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(10 * 1024 * 1024);
    const response = await api<{ report: { boardCount: number; batchCount: number } }>(
      stub,
      alex,
      "/api/import/preview",
      { method: "POST", body: { backup } }
    );
    expect(response.response.status).toBe(200);
    expect(response.body.ok && response.body.data.report).toMatchObject({ boardCount: 10_000, batchCount: 400 });
  });

  it("migrates the previous stored schema explicitly and rejects unknown versions", () => {
    const legacyActionId = crypto.randomUUID();
    const oldRetro = {
      schemaVersion: 0,
      id: crypto.randomUUID(),
      title: "Legacy fixture",
      status: "open",
      captainId: "actor:legacy",
      createdAt: "2026-10-07T12:00:00.000Z",
      updatedAt: "2026-10-07T12:00:00.000Z",
      revision: 1,
      participants: {
        "actor:legacy": {
          actorId: "actor:legacy",
          displayName: "Legacy",
          joinedAt: "2026-10-07T12:00:00.000Z"
        }
      },
      cards: {
        [legacyActionId]: {
          id: legacyActionId,
          columnId: "actions",
          text: "Keep this follow-up",
          authorId: "actor:legacy",
          authorDisplayName: "Legacy",
          actionOwnerName: "Sam",
          version: 1,
          createdAt: "2026-10-07T12:00:00.000Z",
          updatedAt: "2026-10-07T12:00:00.000Z"
        }
      },
      votes: {}
    };
    expect(migrateStoredRetro(oldRetro)).toMatchObject({
      schemaVersion: RETRO_SCHEMA_VERSION,
      lifecycleAudit: [],
      cards: { [legacyActionId]: { columnId: "actions", actionOwnerName: "Sam", text: "Keep this follow-up" } }
    });
    expect(migrateStoredRetro({ ...oldRetro, schemaVersion: 1, lifecycleAudit: [] })).toMatchObject({
      schemaVersion: RETRO_SCHEMA_VERSION,
      cards: { [legacyActionId]: { columnId: "actions", actionOwnerName: "Sam" } }
    });
    const legacyReflectionId = crypto.randomUUID();
    const votedLegacy = {
      ...oldRetro, schemaVersion: 2, lifecycleAudit: [],
      cards: { ...oldRetro.cards, [legacyReflectionId]: { ...oldRetro.cards[legacyActionId], id: legacyReflectionId, columnId: "went-well", actionOwnerName: undefined } },
      votes: { "actor:legacy": [legacyReflectionId] }
    };
    expect(migrateStoredRetro(votedLegacy).reactions).toEqual({ "actor:legacy": [{ cardId: legacyReflectionId, emoji: "👍" }] });
    expect(() => migrateStoredRetro({ ...votedLegacy, votes: { "actor:legacy": [legacyActionId] } })).toThrow("Legacy votes must reference");
    const migratedBackup = parseBackupPreviewBody({ backup: {
      format: "siq-retro-backup", exportVersion: 2, exportedAt: oldRetro.createdAt,
      sourceApplicationVersion: "0.1.0", retros: [votedLegacy]
    } }).backup;
    expect(migratedBackup.exportVersion).toBe(BACKUP_EXPORT_VERSION);
    expect(migratedBackup.retros[0]?.reactions).toEqual({ "actor:legacy": [{ cardId: legacyReflectionId, emoji: "👍" }] });
    const versionThreeRetro = makeRetro();
    const versionThreeCardId = Object.keys(versionThreeRetro.cards)[0]!;
    const versionThreeBackup = parseBackupPreviewBody({ backup: {
      format: "siq-retro-backup", exportVersion: 3, exportedAt: versionThreeRetro.createdAt,
      sourceApplicationVersion: "0.1.0", retros: [versionThreeRetro]
    } }).backup;
    expect(versionThreeBackup.exportVersion).toBe(BACKUP_EXPORT_VERSION);
    expect(versionThreeBackup.retros[0]?.cards[versionThreeCardId]?.sortOrder).toBeUndefined();
    expect(() => migrateStoredRetro({ ...oldRetro, schemaVersion: 99 })).toThrow(
      "Stored retro schema version 99 is not supported."
    );
  });
});

class SocketReader {
  readonly socket: WebSocket;
  private readonly messages: Record<string, unknown>[] = [];
  private readonly waiters: {
    type: string;
    predicate: (value: Record<string, unknown>) => boolean;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      const index = this.waiters.findIndex(
        (waiter) => waiter.type === parsed.type && waiter.predicate(parsed)
      );
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timeout);
        waiter!.resolve(parsed);
      } else {
        this.messages.push(parsed);
      }
    });
  }

  async waitFor(
    type: string,
    timeoutMs = 3_000,
    predicate: (value: Record<string, unknown>) => boolean = () => true
  ): Promise<Record<string, unknown>> {
    const existingIndex = this.messages.findIndex(
      (message) => message.type === type && predicate(message)
    );
    if (existingIndex >= 0) return this.messages.splice(existingIndex, 1)[0]!;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for WebSocket ${type}.`));
      }, timeoutMs);
      this.waiters.push({ type, predicate, resolve, reject, timeout });
    });
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }
}

async function openSocket(
  stub: DurableObjectStub,
  actor: AuthPrincipal,
  retroId: string
): Promise<SocketReader> {
  const response = await stub.fetch(requestFor(actor, `/api/retros/${retroId}/ws?protocolVersion=${PROTOCOL_VERSION}`, {
    headers: { Upgrade: "websocket", Origin: "https://team-retro.test" }
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("The Durable Object did not return a WebSocket client.");
  socket.accept();
  return new SocketReader(socket);
}

describe("hibernatable collaboration runtime", () => {
  it("restores captured socket attachments and permits audited captain recovery after Durable Object eviction", async () => {
    const stub = teamStub();
    const sam = await principal("sam");
    const alex = await principal("alex");
    const retro = await createRetro(stub, sam, "Eviction and recovery");
    await api(stub, alex, `/api/retros/${retro.id}/join`, {
      method: "POST",
      body: { displayName: "Alex" }
    });
    const cardId = crypto.randomUUID();
    await runCommands(stub, sam, retro.id, [
      command("card.create", { cardId, columnId: "went-well", text: "Before hibernation" })
    ]);

    const captainSocket = await openSocket(stub, sam, retro.id);
    const adminSocket = await openSocket(stub, alex, retro.id);
    const captainSnapshot = await captainSocket.waitFor("snapshot");
    await adminSocket.waitFor("snapshot");
    const start = command("retro.prepareFinish", {
      expectedRetroRevision: (captainSnapshot.retro as Retro).revision
    });
    captainSocket.send({ protocolVersion: PROTOCOL_VERSION, commands: [start] });
    const requested = await captainSocket.waitFor("finish.requested");
    await captainSocket.waitFor("ack", 3_000, (message) => message.commandId === start.commandId);
    await adminSocket.waitFor("finish.requested");
    const closing = requested.closing as Retro["closing"];
    if (!closing) throw new Error("The retro did not persist its finish generation.");
    expect(closing.requiredClients).toHaveLength(2);

    await evictDurableObject(stub);

    const pendingText = "The captured editor can finish syncing after eviction.";
    const pendingUpdate = command("card.update", {
      cardId,
      text: pendingText,
      expectedCardVersion: 1
    });
    captainSocket.send({ protocolVersion: PROTOCOL_VERSION, commands: [pendingUpdate] });
    await captainSocket.waitFor("ack", 3_000, (message) => message.commandId === pendingUpdate.commandId);
    await adminSocket.waitFor("events", 3_000, (message) =>
      (message.events as { type: string; cardId?: string }[]).some((event) => event.type === "card.updated" && event.cardId === cardId)
    );

    const duringClosing = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!duringClosing.body.ok) throw new Error("The closing retro could not be read after eviction.");
    expect(duringClosing.body.data.retro.cards[cardId]?.text).toBe(pendingText);
    const recovery = command("captain.recover", {
      newCaptainId: alex.actorId,
      expectedRetroRevision: duringClosing.body.data.retro.revision,
      reason: "Captain unavailable during closing"
    });
    const recoveryResult = await runCommands(stub, alex, retro.id, [recovery]);
    expect(recoveryResult.response.status).toBe(200);
    await adminSocket.waitFor("events", 3_000, (message) =>
      (message.events as { type: string }[]).some((event) => event.type === "captain.recovered")
    );

    for (const socket of [captainSocket, adminSocket]) {
      const ready = command("retro.finishReady", { generation: closing.generation });
      socket.send({ protocolVersion: PROTOCOL_VERSION, commands: [ready] });
      await socket.waitFor("ack", 3_000, (message) => message.commandId === ready.commandId);
    }
    await adminSocket.waitFor("finish.progress", 3_000, (message) => message.readyCount === 2);

    await evictDurableObject(stub);
    const recovered = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!recovered.body.ok) throw new Error("The recovered closing retro could not be read.");
    expect(recovered.body.data.retro.captainId).toBe(alex.actorId);
    expect(recovered.body.data.retro.closing?.readyClients).toHaveLength(2);
    expect(recovered.body.data.retro.lifecycleAudit.at(-1)).toMatchObject({
      type: "captain.recovered",
      administratorId: alex.actorId,
      recoveredCaptainId: alex.actorId,
      reason: "Captain unavailable during closing"
    });

    const finish = command("retro.finalizeFinish", { generation: closing.generation });
    adminSocket.send({ protocolVersion: PROTOCOL_VERSION, commands: [finish] });
    const completed = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    await expect.poll(async () => {
      const current = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
      return current.body.ok && current.body.data.retro.status;
    }).toBe("closed");
    if (!completed.body.ok) throw new Error("The closed retro could not be read.");
    expect(completed.body.data.retro.cards[cardId]?.text).toBe(pendingText);
  });

  it("isolates room broadcasts and accepts only the authenticated socket connection context", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const sam = await principal("sam");
    const first = await createRetro(stub, alex, "First room");
    const second = await createRetro(stub, alex, "Second room");
    for (const retro of [first, second]) {
      await api(stub, sam, `/api/retros/${retro.id}/join`, {
        method: "POST",
        body: { displayName: "Sam" }
      });
    }
    const captainSocket = await openSocket(stub, alex, first.id);
    const samFirstSocket = await openSocket(stub, sam, first.id);
    const samSecondSocket = await openSocket(stub, sam, second.id);
    const snapshot = await samFirstSocket.waitFor("snapshot");
    expect(snapshot.clientId).toMatch(/^[0-9a-f-]{36}$/);
    const cardId = crypto.randomUUID();
    captainSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("card.create", { cardId, columnId: "went-well", text: "Room one" })]
    });
    const firstEvents = await samFirstSocket.waitFor("events");
    expect(firstEvents.retroId).toBe(first.id);
    const editingStart = command("presence.editing", { cardId, editing: true });
    captainSocket.send({ protocolVersion: PROTOCOL_VERSION, commands: [editingStart] });
    const presence = await samFirstSocket.waitFor(
      "presence",
      3_000,
      (message) => message.actorId === alex.actorId && message.cardId === cardId
    );
    expect(presence.displayName).toBe("alex");
    const extraAlexTab = await openSocket(stub, alex, first.id);
    const restoredPresence = await extraAlexTab.waitFor(
      "presence",
      3_000,
      (message) => message.actorId === alex.actorId && message.cardId === cardId
    );
    expect(restoredPresence.editing).toBe(true);
    captainSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("presence.editing", { cardId, editing: false })]
    });
    await samFirstSocket.waitFor(
      "presence",
      3_000,
      (message) => message.actorId === alex.actorId && message.cardId === null
    );
    await expect(samSecondSocket.waitFor("events", 250)).rejects.toThrow("Timed out");
    expect(samSecondSocket.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("broadcasts GIPHY selections to connected participants without changing board history", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const sam = await principal("sam");
    const retro = await createRetro(stub, alex, "Ephemeral GIPHY share");
    await api(stub, sam, `/api/retros/${retro.id}/join`, {
      method: "POST",
      body: { displayName: "Sam" }
    });
    const alexSocket = await openSocket(stub, alex, retro.id);
    const samSocket = await openSocket(stub, sam, retro.id);
    await Promise.all([alexSocket.waitFor("snapshot"), samSocket.waitFor("snapshot")]);
    const before = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!before.body.ok) throw new Error("The retro could not be read before the GIPHY share.");

    const media = {
      id: "giphy-fixture",
      imageUrl: "https://media2.giphy.com/media/giphy-fixture/200.gif",
      title: "A celebration"
    };
    alexSocket.send({ protocolVersion: PROTOCOL_VERSION, type: "giphy.share", media });
    const [alexMessage, samMessage] = await Promise.all([
      alexSocket.waitFor("giphy.shared"),
      samSocket.waitFor("giphy.shared")
    ]);
    expect(alexMessage.retroId).toBe(retro.id);
    expect(alexMessage.media).toEqual(media);
    expect(samMessage.shareId).toBe(alexMessage.shareId);
    expect(alexMessage).not.toHaveProperty("actorId");

    const after = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!after.body.ok) throw new Error("The retro could not be read after the GIPHY share.");
    expect(after.body.data.retro.revision).toBe(before.body.data.retro.revision);
    expect(JSON.stringify(after.body.data.retro)).not.toContain(media.id);
    alexSocket.socket.close();
    samSocket.socket.close();
  });

  it("binds finish readiness to captured socket IDs and rejects a stale closing generation", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const sam = await principal("sam");
    const retro = await createRetro(stub, alex, "Closing handshake");
    await api(stub, sam, `/api/retros/${retro.id}/join`, {
      method: "POST",
      body: { displayName: "Sam" }
    });
    const pendingCardId = crypto.randomUUID();
    await runCommands(stub, sam, retro.id, [
      command("card.create", { cardId: pendingCardId, columnId: "went-well", text: "Before closing" })
    ]);
    const captainSocket = await openSocket(stub, alex, retro.id);
    const samSocket = await openSocket(stub, sam, retro.id);
    const joined = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!joined.body.ok) throw new Error("The retro could not be read.");
    const start = command("retro.prepareFinish", {
      expectedRetroRevision: joined.body.data.retro.revision
    });
    captainSocket.send({ protocolVersion: PROTOCOL_VERSION, commands: [start] });
    const requested = await captainSocket.waitFor("finish.requested");
    await captainSocket.waitFor("ack");
    const firstGeneration = (requested.closing as { generation: string }).generation;

    samSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("card.update", {
        cardId: pendingCardId,
        text: "Synced during closing",
        expectedCardVersion: 1
      })]
    });
    await samSocket.waitFor("ack");
    const synced = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    expect(synced.body.ok && synced.body.data.retro.cards[pendingCardId]?.text).toBe("Synced during closing");

    const spoofedHttpReady = await runCommands(stub, sam, retro.id, [
      command("retro.finishReady", { generation: firstGeneration })
    ]);
    expect(spoofedHttpReady.response.status).toBe(403);
    samSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("retro.finishReady", { generation: firstGeneration })]
    });
    await samSocket.waitFor("ack");

    captainSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("retro.cancelFinish", { generation: firstGeneration })]
    });
    await captainSocket.waitFor("ack");
    const currentAfterCancel = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    if (!currentAfterCancel.body.ok) throw new Error("The retro could not be read.");
    const secondStart = command("retro.prepareFinish", {
      expectedRetroRevision: currentAfterCancel.body.data.retro.revision
    });
    captainSocket.send({ protocolVersion: PROTOCOL_VERSION, commands: [secondStart] });
    const nextRequested = await captainSocket.waitFor("finish.requested");
    await captainSocket.waitFor("ack");
    const nextGeneration = (nextRequested.closing as { generation: string }).generation;
    expect(nextGeneration).not.toBe(firstGeneration);
    samSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("retro.finishReady", { generation: firstGeneration })]
    });
    const staleError = await samSocket.waitFor("command.error");
    expect((staleError.error as { code: string }).code).toBe("CONFLICT");
    const current = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    expect(current.body.ok && current.body.data.retro.closing?.readyClients).toHaveLength(0);
  });

  it("marks a finish timeout durably but does not close until the captain explicitly confirms saved content", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const retro = await createRetro(stub, alex, "Finish timeout");
    const captainSocket = await openSocket(stub, alex, retro.id);
    captainSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("retro.prepareFinish", { expectedRetroRevision: retro.revision })]
    });
    await captainSocket.waitFor("finish.requested");
    await captainSocket.waitFor("ack");
    await captainSocket.waitFor("finish.progress", 20_000);
    const deadlineStart = Date.now();
    while (Date.now() - deadlineStart < 20_000) {
      const state = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
      if (state.body.ok && state.body.data.retro.closing?.deadlineReached) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const closing = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    expect(closing.body.ok && closing.body.data.retro.status).toBe("closing");
    expect(closing.body.ok && closing.body.data.retro.closing?.deadlineReached).toBe(true);
    if (!closing.body.ok || !closing.body.data.retro.closing) throw new Error("The timeout was not recorded.");

    const generation = closing.body.data.retro.closing.generation;
    captainSocket.send({
      protocolVersion: PROTOCOL_VERSION,
      commands: [command("retro.finalizeFinish", {
        generation,
        forceSavedContent: true,
        confirmation: "finish-saved-content"
      })]
    });
    const closed = await api<{ retro: Retro }>(stub, alex, `/api/retros/${retro.id}`);
    expect(closed.body.ok && closed.body.data.retro.status).toBe("closed");
    expect(closed.body.ok && closed.body.data.retro.lifecycleAudit.at(-1)?.type).toBe("retro.force-finished");
  }, 30_000);

  it("closes an idle socket at its verified session expiry", async () => {
    const stub = teamStub();
    const alex = await principal("alex");
    const retro = await createRetro(stub, alex, "Session expiry");
    const shortSession = AuthPrincipalSchema.parse({
      ...alex,
      expiresAt: new Date(Date.now() + 2_000).toISOString()
    });
    const client = await openSocket(stub, shortSession, retro.id);
    await client.waitFor("snapshot");
    const close = await new Promise<CloseEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Expired socket was not closed by its alarm.")), 6_000);
      client.socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve(event);
      }, { once: true });
    });
    expect(close.code).toBe(4001);
  }, 10_000);
});
