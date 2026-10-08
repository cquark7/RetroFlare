import { isVotableColumn, LIMITS, RETRO_SCHEMA_VERSION, type ColumnId } from "../src/shared/constants";
import type { RetroStatus } from "../src/shared/constants";
import { RetroSchema, RetroSummarySchema, ActorIdSchema, UuidSchema } from "../src/shared/domain";
import { z } from "zod";
import type { Retro, RetroSummary } from "../src/shared/domain";

export const retroKey = (id: string): string => `retro:${id}`;
export const summaryKey = (id: string): string => `summary:${id}`;
export const statusIndexKey = (retro: Pick<Retro, "id" | "status" | "createdAt">): string =>
  `index:status:${retro.status}:${retro.createdAt}:${retro.id}`;
export const activeIndexKey = (retro: Pick<Retro, "id" | "status" | "createdAt">): string =>
  `index:active:${retro.createdAt}:${retro.id}`;
export const allIndexKey = (retro: Pick<Retro, "id" | "createdAt">): string =>
  `index:all:${retro.createdAt}:${retro.id}`;
export const operationsKey = (id: string): string => `operations:${id}`;
export const closingDeadlineKey = (deadline: string, id: string): string =>
  `deadline:${deadline}:${id}`;

export class StorageError extends Error {
  readonly code: "PAYLOAD_TOO_LARGE" | "RATE_LIMITED" | "INTERNAL_ERROR";

  constructor(
    message: string,
    code: "PAYLOAD_TOO_LARGE" | "RATE_LIMITED" | "INTERNAL_ERROR" = "INTERNAL_ERROR"
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export class RetroSchemaVersionError extends Error {
  constructor(version: unknown) {
    super(`Stored retro schema version ${String(version)} is not supported.`);
    this.name = "RetroSchemaVersionError";
  }
}

/** Upgrade a stored document before validating it against the current source-of-truth schema. */
export function migrateStoredRetro(value: unknown): Retro {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageError("Stored retro document is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === RETRO_SCHEMA_VERSION) return RetroSchema.parse(record);
  if (record.schemaVersion === 0 || record.schemaVersion === 1 || record.schemaVersion === 2) {
    const votes = z.record(ActorIdSchema, z.array(UuidSchema).max(LIMITS.votesPerParticipant)
      .refine((ids) => new Set(ids).size === ids.length)).parse(record.votes);
    for (const ids of Object.values(votes)) {
      for (const id of ids) {
        const column = (record.cards as Record<string, { columnId?: unknown }> | undefined)?.[id]?.columnId;
        if (!isVotableColumn(column as ColumnId)) throw new StorageError("Legacy votes must reference a card in a votable column.");
      }
    }
    const { votes: legacyVotes, ...rest } = record;
    void legacyVotes;
    return RetroSchema.parse({
      ...rest,
      schemaVersion: RETRO_SCHEMA_VERSION,
      reactions: Object.fromEntries(Object.entries(votes).map(([actorId, ids]) => [actorId, ids.map((cardId) => ({ cardId, emoji: "👍" }))])),
      lifecycleAudit: record.schemaVersion === 0 && !Array.isArray(record.lifecycleAudit) ? [] : record.lifecycleAudit
    });
  }
  throw new RetroSchemaVersionError(record.schemaVersion);
}

export function serializeRetro(retro: Retro): string {
  const parsed = RetroSchema.parse(retro);
  const serialized = JSON.stringify(parsed);
  if (new TextEncoder().encode(serialized).byteLength > LIMITS.serializedRetroBytes) {
    throw new StorageError("The retro is too large to save.", "PAYLOAD_TOO_LARGE");
  }
  return serialized;
}

export function summaryFromRetro(retro: Retro): RetroSummary {
  return RetroSummarySchema.parse({
    id: retro.id,
    title: retro.title,
    status: retro.status,
    captainId: retro.captainId,
    captainDisplayName: retro.participants[retro.captainId]?.displayName ?? "Unknown",
    createdAt: retro.createdAt,
    updatedAt: retro.updatedAt,
    ...(retro.closedAt ? { closedAt: retro.closedAt } : {}),
    cardCount: Object.keys(retro.cards).length,
    participantCount: Object.keys(retro.participants).length,
    revision: retro.revision
  });
}

export async function readRetro(
  storage: DurableObjectStorage | DurableObjectTransaction,
  id: string
): Promise<Retro | undefined> {
  const value = await storage.get<unknown>(retroKey(id));
  if (value === undefined) return undefined;
  return migrateStoredRetro(value);
}

export async function writeRetro(
  transaction: DurableObjectTransaction,
  retro: Retro,
  isNew = false
): Promise<void> {
  const serialized = serializeRetro(retro);
  const summary = summaryFromRetro(retro);
  const priorSummary = await transaction.get<RetroSummary>(summaryKey(retro.id));
  const statusChanged = priorSummary !== undefined && priorSummary.status !== retro.status;
  if (priorSummary && statusChanged) {
    await transaction.delete(statusIndexKey({
      id: retro.id,
      status: priorSummary.status,
      createdAt: retro.createdAt
    }));
    if (priorSummary.status !== "closed") {
      await transaction.delete(activeIndexKey({ id: retro.id, status: priorSummary.status, createdAt: retro.createdAt }));
    }
  }
  await transaction.put(retroKey(retro.id), JSON.parse(serialized) as Retro);
  await transaction.put(summaryKey(retro.id), summary);
  const statusKey = statusIndexKey(retro);
  const priorStatusIndex = await transaction.get<unknown>(statusKey);
  if (statusChanged || priorStatusIndex !== retro.id) {
    await transaction.put(statusKey, retro.id);
  }
  if (retro.status !== "closed") {
    const activeKey = activeIndexKey(retro);
    const priorActiveIndex = await transaction.get<unknown>(activeKey);
    if (statusChanged || priorActiveIndex !== retro.id) {
      await transaction.put(activeKey, retro.id);
    }
  }
  if (isNew) {
    await transaction.put(allIndexKey(retro), retro.id);
    const lastSequence = (await transaction.get<number>("index:sequence:last")) ?? 0;
    const nextSequence = lastSequence + 1;
    const sequenceKey = `index:sequence:${String(nextSequence).padStart(16, "0")}`;
    await transaction.put(sequenceKey, retro.id);
    await transaction.put("index:sequence:last", nextSequence);
  }
}

export async function consumeActorMutationBudget(
  transaction: DurableObjectTransaction,
  actorId: string,
  now: number
): Promise<void> {
  const key = `budget:actor:${actorId}`;
  const prior = (await transaction.get<number[]>(key)) ?? [];
  const active = prior.filter((timestamp) => timestamp > now - 60_000);
  const limit = LIMITS.actorMutationsPerMinute + LIMITS.actorMutationBurst;
  if (active.length >= limit) {
    throw new StorageError(
      `Rate limit exceeded; retry after ${Math.ceil((active[0]! + 60_000 - now) / 1000)} seconds.`,
      "RATE_LIMITED"
    );
  }
  active.push(now);
  await transaction.put(key, active);
}

export async function consumeRetroCreationBudget(
  transaction: DurableObjectTransaction,
  actorId: string,
  now: number
): Promise<void> {
  const actorKey = `budget:create:actor:${actorId}`;
  const actorPrior = (await transaction.get<number[]>(actorKey)) ?? [];
  const actorActive = actorPrior.filter((timestamp) => timestamp > now - 60 * 60_000);
  if (actorActive.length >= LIMITS.retroCreationsPerActorPerHour) {
    throw new StorageError("The hourly retro creation limit has been reached.", "RATE_LIMITED");
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const deploymentKey = "budget:create:deployment";
  const deploymentBudget = await transaction.get<{ day: string; count: number }>(deploymentKey);
  const deploymentCount = deploymentBudget?.day === day ? deploymentBudget.count : 0;
  if (deploymentCount >= LIMITS.retroCreationsPerDeploymentPerDay) {
    throw new StorageError("The daily retro creation limit has been reached.", "RATE_LIMITED");
  }

  actorActive.push(now);
  await transaction.put(actorKey, actorActive);
  await transaction.put(deploymentKey, { day, count: deploymentCount + 1 });
}

export function indexPrefixForStatus(status: RetroStatus): string {
  return `index:status:${status}:`;
}
