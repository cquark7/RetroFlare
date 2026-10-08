import { describe, expect, it } from "vitest";
import { BackupDocumentSchema, ImportPreviewReportSchema } from "../src/shared/backup";
import {
  ClientWebSocketFrameSchema,
  CommandFrameSchema,
  ClientCommandSchema,
  GiphyMediaSchema,
  ServerMessageSchema
} from "../src/shared/protocol";
import { RetroSchema } from "../src/shared/domain";
import { reduceRetroEvent } from "../src/shared/reducer";
import { BACKUP_EXPORT_VERSION, PROTOCOL_VERSION } from "../src/shared/constants";
import { makeRetro, actorId, cardId, retroId, timestamp } from "./fixtures";

describe("shared protocol and persisted contracts", () => {
  it("accepts intended commands but rejects browser-supplied actor or role claims", () => {
    const command = {
      protocolVersion: PROTOCOL_VERSION,
      commandId: crypto.randomUUID(),
      type: "reaction.set",
      payload: { cardId, emoji: "👍", reacted: true }
    };

    expect(ClientCommandSchema.safeParse(command).success).toBe(true);
    expect(ClientCommandSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      commandId: crypto.randomUUID(),
      type: "card.reorder",
      payload: {
        cardId: crypto.randomUUID(),
        columnId: "went-well",
        orderedCardIds: [crypto.randomUUID(), crypto.randomUUID()],
        expectedRetroRevision: 1
      }
    }).success).toBe(true);
    expect(ClientCommandSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      commandId: crypto.randomUUID(),
      type: "card.reorder",
      payload: {
        cardId: crypto.randomUUID(),
        columnId: "went-well",
        orderedCardIds: [cardId, cardId],
        expectedRetroRevision: 1
      }
    }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ ...command, protocolVersion: 1 }).success).toBe(false);
    expect(
      ClientCommandSchema.safeParse({ ...command, actorId: "attacker" }).success
    ).toBe(false);
    expect(
      ClientCommandSchema.safeParse({
        ...command,
        payload: { ...command.payload, role: "captain" }
      }).success
    ).toBe(false);
    expect(
      ClientCommandSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        commandId: crypto.randomUUID(),
        type: "retro.finishReady",
        payload: { generation: crypto.randomUUID(), clientId: crypto.randomUUID() }
      }).success
    ).toBe(false);
    expect(
      ClientCommandSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        commandId: crypto.randomUUID(),
        type: "captain.recover",
        payload: {
          newCaptainId: actorId,
          expectedRetroRevision: 1,
          isAdministrator: true
        }
      }).success
    ).toBe(false);
  });

  it("bounds transport batches and requires desired-state reaction commands", () => {
    const commands = Array.from({ length: 11 }, () => ({
      protocolVersion: PROTOCOL_VERSION,
      commandId: crypto.randomUUID(),
      type: "reaction.set",
      payload: { cardId, emoji: "👍", reacted: true }
    }));
    expect(CommandFrameSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, commands }).success).toBe(false);
    expect(
      ClientCommandSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        commandId: crypto.randomUUID(),
        type: "reaction.set",
        payload: { cardId, increment: 1 }
      }).success
    ).toBe(false);
  });

  it("validates GIPHY shares as actor-free ephemeral socket messages with provider media URLs", () => {
    const media = {
      id: "giphy-fixture",
      imageUrl: "https://media2.giphy.com/media/giphy-fixture/200.gif",
      title: "A celebration"
    };
    const request = { protocolVersion: PROTOCOL_VERSION, type: "giphy.share", media };
    expect(ClientWebSocketFrameSchema.safeParse(request).success).toBe(true);
    expect(ClientWebSocketFrameSchema.safeParse({ ...request, actorId }).success).toBe(false);
    expect(GiphyMediaSchema.safeParse({
      ...media,
      imageUrl: "https://media.giphy.com.evil.example/media/giphy-fixture/200.gif"
    }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({
      type: "giphy.shared",
      protocolVersion: PROTOCOL_VERSION,
      retroId,
      shareId: crypto.randomUUID(),
      media
    }).success).toBe(true);
  });

  it("enforces cross-entity reaction references and readiness actor binding", () => {
    const retro = makeRetro();
    expect(RetroSchema.safeParse(retro).success).toBe(true);
    const shoutoutId = crypto.randomUUID();
    const shoutout = { ...retro.cards[cardId]!, id: shoutoutId, columnId: "shoutouts" as const };
    const actionId = crypto.randomUUID();
    const actionItem = { ...retro.cards[cardId]!, id: actionId, columnId: "actions" as const, actionOwnerName: "Sam" };
    const withNewCategories = { ...retro, cards: { ...retro.cards, [shoutoutId]: shoutout, [actionId]: actionItem } };
    expect(RetroSchema.safeParse(withNewCategories).success).toBe(true);
    expect(
      RetroSchema.safeParse({ ...withNewCategories, reactions: { [actorId]: [{ cardId: shoutoutId, emoji: "🎉" }, { cardId: actionId, emoji: "💡" }] } }).success
    ).toBe(true);
    expect(
      RetroSchema.safeParse({ ...retro, reactions: { [actorId]: [{ cardId: crypto.randomUUID(), emoji: "👍" }] } }).success
    ).toBe(false);
    expect(RetroSchema.safeParse({ ...retro, reactions: { [actorId]: [{ cardId, emoji: "👍" }, { cardId, emoji: "👍" }] } }).success).toBe(false);
    expect(RetroSchema.safeParse({ ...retro, reactions: { stranger: [{ cardId, emoji: "👍" }] } }).success).toBe(false);
    expect(ClientCommandSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, commandId: crypto.randomUUID(), type: "reaction.set", payload: { cardId, emoji: "unknown", reacted: true } }).success).toBe(false);

    const closing = {
      generation: crypto.randomUUID(),
      requestedBy: actorId,
      requestedAt: timestamp,
      deadline: "2026-10-07T12:00:15.000Z",
      deadlineReached: false,
      requiredClients: [{ clientId: crypto.randomUUID(), actorId }],
      readyClients: [
        {
          clientId: crypto.randomUUID(),
          actorId: "actor:someone-else",
          readyAt: timestamp
        }
      ]
    };
    expect(RetroSchema.safeParse({ ...retro, status: "closing", closing }).success).toBe(false);
  });

  it("supports schema-versioned backup documents without silently duplicating retro IDs", () => {
    const retro = makeRetro();
    const backup = {
      format: "retroflare-backup",
      exportVersion: BACKUP_EXPORT_VERSION,
      exportedAt: timestamp,
      sourceApplicationVersion: "0.1.0",
      retros: [retro]
    };
    expect(BackupDocumentSchema.safeParse(backup).success).toBe(true);
    expect(BackupDocumentSchema.safeParse({ ...backup, exportVersion: 3 }).success).toBe(true);
    expect(BackupDocumentSchema.safeParse({ ...backup, format: "siq-retro-backup" }).success).toBe(true);
    expect(BackupDocumentSchema.safeParse({ ...backup, format: "unrelated-backup" }).success).toBe(false);
    expect(
      BackupDocumentSchema.safeParse({ ...backup, retros: [retro, retro] }).success
    ).toBe(false);
  });

  it("keeps import preview write batches within the 25-board atomic limit", () => {
    const items = Array.from({ length: 26 }, (_, index) => ({
      retroId: crypto.randomUUID(),
      title: `Retro ${index}`,
      incomingStatus: "closed" as const,
      disposition: "create" as const,
      importedStatus: "closed" as const,
      batchNumber: 1
    }));
    expect(
      ImportPreviewReportSchema.safeParse({
        boardCount: 26,
        createCount: 26,
        skipIdenticalCount: 0,
        conflictCount: 0,
        batchCount: 1,
        items
      }).success
    ).toBe(false);
  });

  it("reduces a concrete card delta and requests a snapshot for a revision gap", () => {
    const retro = makeRetro();
    const update = {
      type: "card.updated" as const,
      retroId,
      revision: 2,
      occurredAt: "2026-10-07T12:00:02.000Z",
      cardId,
      text: "Deploys were calm and observable",
      actionOwnerName: null,
      version: 2,
      updatedAt: "2026-10-07T12:00:02.000Z"
    };
    const applied = reduceRetroEvent(retro, update);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") throw new Error("Expected event to apply.");
    expect(applied.retro.cards[cardId]?.text).toBe("Deploys were calm and observable");
    expect(applied.retro.revision).toBe(2);
    expect(reduceRetroEvent(applied.retro, update).status).toBe("ignored");
    expect(
      reduceRetroEvent(applied.retro, { ...update, revision: 4 }).status
    ).toBe("resync-required");
  });

  it("reduces a same-column reorder into explicit persistent positions", () => {
    const retro = makeRetro();
    const secondCardId = "00000000-0000-4000-8000-000000000005";
    const created = reduceRetroEvent(retro, {
      type: "card.created",
      retroId,
      revision: 2,
      occurredAt: "2026-10-07T12:00:01.000Z",
      card: {
        ...retro.cards[cardId]!,
        id: secondCardId,
        text: "Keep the notes in order.",
        createdAt: "2026-10-07T12:00:01.000Z",
        updatedAt: "2026-10-07T12:00:01.000Z"
      }
    });
    expect(created.status).toBe("applied");
    if (created.status !== "applied") throw new Error("Expected the new card event to apply.");

    const reordered = reduceRetroEvent(created.retro, {
      type: "card.reordered",
      retroId,
      revision: 3,
      occurredAt: "2026-10-07T12:00:02.000Z",
      cardId: secondCardId,
      columnId: "went-well",
      orderedCardIds: [secondCardId, cardId]
    });

    expect(reordered.status).toBe("applied");
    if (reordered.status !== "applied") throw new Error("Expected the reorder event to apply.");
    expect(reordered.retro.cards[secondCardId]?.sortOrder).toBe(0);
    expect(reordered.retro.cards[cardId]?.sortOrder).toBe(1);
    expect(RetroSchema.safeParse(reordered.retro).success).toBe(true);
  });

  it("accepts legacy chronological columns and rejects incomplete or duplicate positions", () => {
    const retro = makeRetro();
    const secondCardId = "00000000-0000-4000-8000-000000000008";
    const secondCard = {
      ...retro.cards[cardId]!,
      id: secondCardId,
      createdAt: "2026-10-07T12:00:01.000Z",
      updatedAt: "2026-10-07T12:00:01.000Z"
    };
    expect(RetroSchema.safeParse(retro).success).toBe(true);
    expect(RetroSchema.safeParse({
      ...retro,
      cards: { ...retro.cards, [cardId]: { ...retro.cards[cardId]!, sortOrder: 0 }, [secondCardId]: secondCard }
    }).success).toBe(false);
    expect(RetroSchema.safeParse({
      ...retro,
      cards: {
        ...retro.cards,
        [cardId]: { ...retro.cards[cardId]!, sortOrder: 0 },
        [secondCardId]: { ...secondCard, sortOrder: 0 }
      }
    }).success).toBe(false);
  });
});
