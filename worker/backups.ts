import {
  BACKUP_EXPORT_VERSION,
  BACKUP_FORMAT,
  LIMITS
} from "../src/shared/constants";
import type { RetroStatus } from "../src/shared/constants";
import {
  BackupDocumentSchema,
  BackupPageSchema,
  ImportPreviewRequestSchema,
  ImportRequestSchema
} from "../src/shared/backup";
import { ExportAllQuerySchema } from "../src/shared/api";
import type {
  BackupDocument,
  ImportPreviewReport,
  ImportResult
} from "../src/shared/backup";
import { RetroSchema } from "../src/shared/domain";
import type { Retro } from "../src/shared/domain";
import type { AuthPrincipal } from "../src/shared/auth";
import { BackendError, apiSuccess, zodError } from "./http";
import {
  consumeActorMutationBudget,
  migrateStoredRetro,
  readRetro,
  retroKey,
  serializeRetro,
  writeRetro
} from "./storage";

const SOURCE_APPLICATION_VERSION = "0.1.0";
const PREVIEW_LIFETIME_MS = 10 * 60_000;
const EXPORT_SEQUENCE_PREFIX = "index:sequence:";
const PREVIEW_PREFIX = "import-preview:";

type ImportPreviewRecord = {
  actorId: string;
  backupHash: string;
  expiresAt: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashBackup(backup: BackupDocument): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(backup));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function migrateBackupDocument(value: unknown): BackupDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackendError("INVALID_REQUEST", "The backup document must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.exportVersion !== BACKUP_EXPORT_VERSION && record.exportVersion !== 3 && record.exportVersion !== 2) {
    throw new BackendError(
      "INVALID_REQUEST",
      `Backup export version ${String(record.exportVersion)} is not supported.`
    );
  }
  if (!Array.isArray(record.retros)) {
    throw new BackendError("INVALID_REQUEST", "The backup must contain a retros array.");
  }
  const migratedRetros = record.retros.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    try {
      return migrateStoredRetro(entry);
    } catch {
      throw new BackendError("INVALID_REQUEST", "The backup contains an invalid or unsupported retro document.");
    }
  });
  const parsed = BackupDocumentSchema.safeParse({ ...record, exportVersion: BACKUP_EXPORT_VERSION, retros: migratedRetros });
  if (!parsed.success) throw zodError(parsed.error);
  for (const retro of parsed.data.retros) serializeRetro(retro);
  return parsed.data;
}

export function parseBackupPreviewBody(value: unknown): { backup: BackupDocument } {
  const migrated =
    value && typeof value === "object" && !Array.isArray(value) && "backup" in value
      ? migrateBackupDocument((value as { backup: unknown }).backup)
      : undefined;
  if (!migrated) throw new BackendError("INVALID_REQUEST", "The request must contain a backup document.");
  const parsed = ImportPreviewRequestSchema.safeParse({ backup: migrated });
  if (!parsed.success) throw zodError(parsed.error);
  return parsed.data;
}

export function parseBackupImportBody(value: unknown): {
  previewId: string;
  confirmation: "append-only-import";
  backup: BackupDocument;
} {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("backup" in value)) {
    throw new BackendError("INVALID_REQUEST", "The request must contain a backup document.");
  }
  const record = value as Record<string, unknown>;
  const backup = migrateBackupDocument(record.backup);
  const parsed = ImportRequestSchema.safeParse({ ...record, backup });
  if (!parsed.success) throw zodError(parsed.error);
  if (new TextEncoder().encode(JSON.stringify(parsed.data.backup)).byteLength > LIMITS.bulkImportBytes) {
    throw new BackendError("PAYLOAD_TOO_LARGE", "The backup document exceeds the 10 MiB import limit.");
  }
  return parsed.data;
}

function backupHeader(exportedAt: string) {
  return {
    format: BACKUP_FORMAT,
    exportVersion: BACKUP_EXPORT_VERSION,
    exportedAt,
    sourceApplicationVersion: SOURCE_APPLICATION_VERSION
  } as const;
}

export function singleRetroExport(retro: Retro): Response {
  const backup = BackupDocumentSchema.parse({
    ...backupHeader(new Date().toISOString()),
    retros: [retro]
  });
  return new Response(JSON.stringify(backup), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="retroflare-${retro.id}.json"`
    }
  });
}

function sequenceKey(sequence: number): string {
  return `${EXPORT_SEQUENCE_PREFIX}${String(sequence).padStart(16, "0")}`;
}

export async function streamAllRetros(storage: DurableObjectStorage): Promise<Response> {
  const capturedLastSequence = (await storage.get<number>("index:sequence:last")) ?? 0;
  const exportedAt = new Date().toISOString();
  const upperBound = sequenceKey(capturedLastSequence + 1);
  const encoder = new TextEncoder();
  let started = false;
  let ended = false;
  let lastSequenceKey = sequenceKey(0);
  let firstRetro = true;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(
            encoder.encode(`${JSON.stringify(backupHeader(exportedAt)).slice(0, -1)},"retros":[`)
          );
          if (capturedLastSequence === 0) {
            controller.enqueue(encoder.encode("]}"));
            ended = true;
            controller.close();
            return;
          }
        }
        if (ended) return;
        const indexed = await storage.list<string>({
          prefix: EXPORT_SEQUENCE_PREFIX,
          startAfter: lastSequenceKey,
          end: upperBound,
          limit: 1
        });
        const [entry] = indexed.entries();
        if (!entry) {
          controller.enqueue(encoder.encode("]}"));
          ended = true;
          controller.close();
          return;
        }
        const [indexKey, retroId] = entry;
        lastSequenceKey = indexKey;
        const retro = await readRetro(storage, retroId);
        if (!retro) throw new Error("The captured export index references a missing retro.");
        const serialized = serializeRetro(retro);
        controller.enqueue(encoder.encode(`${firstRetro ? "" : ","}${serialized}`));
        firstRetro = false;
      } catch {
        controller.error(new Error("The backup export could not be completed."));
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="retroflare-backup.json"'
    }
  });
}

function encodeCursor(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): string {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    if (!decoded.startsWith("index:all:")) throw new Error("Invalid index key.");
    return decoded;
  } catch {
    throw new BackendError("INVALID_REQUEST", "The export cursor is invalid.");
  }
}

export async function pagedExport(
  storage: DurableObjectStorage,
  cursor: string | undefined,
  pageSize: number
): Promise<Response> {
  const startAfter = cursor ? decodeCursor(cursor) : undefined;
  const indexPage = await storage.list<string>({
    prefix: "index:all:",
    ...(startAfter ? { startAfter } : {}),
    limit: pageSize + 1
  });
  const entries = [...indexPage.entries()];
  const hasMore = entries.length > pageSize;
  const pageEntries = entries.slice(0, pageSize);
  const retros: Retro[] = [];
  for (const [, retroId] of pageEntries) {
    const retro = await readRetro(storage, retroId);
    if (!retro) throw new BackendError("INTERNAL_ERROR", "An export index references a missing retro.");
    retros.push(retro);
  }
  const nextCursor = hasMore && pageEntries.length
    ? encodeCursor(pageEntries[pageEntries.length - 1]![0])
    : undefined;
  return apiSuccess(
    BackupPageSchema.parse({
      ...backupHeader(new Date().toISOString()),
      retros,
      ...(nextCursor ? { nextCursor } : {}),
      hasMore
    })
  );
}

function sourceStatus(retro: Retro): RetroStatus {
  return retro.importMetadata?.importedFromStatus ?? retro.status;
}

function canonicalSourceRetro(retro: Retro): string {
  const source = sourceStatus(retro);
  const canonical: Record<string, unknown> = {
    ...retro,
    status: source
  };
  delete canonical.importMetadata;
  if (source !== "closed") {
    delete canonical.closedAt;
    delete canonical.closing;
  }
  return canonicalJson(canonical);
}

function importedRetro(retro: Retro, importedAt: string): Retro {
  const importedStatus = sourceStatus(retro);
  const normalized: Record<string, unknown> = {
    ...retro,
    status: "closed",
    ...(importedStatus === "closed"
      ? (retro.closedAt ? { closedAt: retro.closedAt } : {})
      : { closedAt: importedAt }),
    importMetadata: { importedAt, importedFromStatus: importedStatus }
  };
  delete normalized.closing;
  return RetroSchema.parse(normalized);
}

async function existingDisposition(
  storage: DurableObjectStorage,
  incoming: Retro
): Promise<"create" | "skip-identical" | "id-conflict"> {
  const existing = await readRetro(storage, incoming.id);
  if (!existing) return "create";
  return canonicalSourceRetro(existing) === canonicalSourceRetro(incoming)
    ? "skip-identical"
    : "id-conflict";
}

async function pruneOldPreviews(
  storage: DurableObjectStorage | DurableObjectTransaction,
  now: number
): Promise<void> {
  const entries = await storage.list<ImportPreviewRecord>({ prefix: PREVIEW_PREFIX, limit: 100 });
  const expired = [...entries.entries()]
    .filter(([, record]) => Date.parse(record.expiresAt) <= now)
    .map(([key]) => key);
  if (expired.length) await storage.delete(expired);
}

async function createPreview(
  state: DurableObjectState,
  principal: AuthPrincipal,
  backup: BackupDocument
): Promise<Response> {
  if (!principal.isAdministrator) throw new BackendError("FORBIDDEN", "Only a configured administrator can preview imports.");
  const backupHash = await hashBackup(backup);
  const items: ImportPreviewReport["items"] = [];
  for (let offset = 0; offset < backup.retros.length; offset += LIMITS.importBatchBoards) {
    const batch = backup.retros.slice(offset, offset + LIMITS.importBatchBoards);
    const batchItems = await Promise.all(batch.map(async (retro) => ({
        retroId: retro.id,
        title: retro.title,
        incomingStatus: sourceStatus(retro),
        disposition: await existingDisposition(state.storage, retro),
        importedStatus: "closed" as const,
        batchNumber: Math.floor(offset / LIMITS.importBatchBoards) + 1
      })));
    items.push(...batchItems);
  }
  const report = {
    boardCount: items.length,
    createCount: items.filter((item) => item.disposition === "create").length,
    skipIdenticalCount: items.filter((item) => item.disposition === "skip-identical").length,
    conflictCount: items.filter((item) => item.disposition === "id-conflict").length,
    batchCount: Math.ceil(items.length / LIMITS.importBatchBoards),
    items
  } satisfies ImportPreviewReport;
  const previewId = crypto.randomUUID();
  const now = Date.now();
  const preview: ImportPreviewRecord = {
    actorId: principal.actorId,
    backupHash,
    expiresAt: new Date(now + PREVIEW_LIFETIME_MS).toISOString()
  };
  await state.storage.transaction(async (transaction) => {
    await consumeActorMutationBudget(transaction, principal.actorId, now);
    await pruneOldPreviews(transaction, now);
    await transaction.put(`${PREVIEW_PREFIX}${previewId}`, preview);
  });
  return apiSuccess({ previewId, report });
}

async function applyImportBatch(
  state: DurableObjectState,
  batchNumber: number,
  incoming: Retro[],
  importedAt: string
): Promise<ImportResult["batches"][number]> {
  try {
    return await state.storage.transaction(async (transaction) => {
      const dispositions = new Map<string, "create" | "skip-identical" | "id-conflict">();
      for (const retro of incoming) {
        const storedValue = await transaction.get<unknown>(retroKey(retro.id));
        if (storedValue === undefined) {
          dispositions.set(retro.id, "create");
          continue;
        }
        const existing = migrateStoredRetro(storedValue);
        dispositions.set(
          retro.id,
          canonicalSourceRetro(existing) === canonicalSourceRetro(retro)
            ? "skip-identical"
            : "id-conflict"
        );
      }
      const conflicts = [...dispositions.entries()]
        .filter(([, disposition]) => disposition === "id-conflict")
        .map(([id]) => id);
      const skipped = [...dispositions.entries()]
        .filter(([, disposition]) => disposition === "skip-identical")
        .map(([id]) => id);
      const created: string[] = [];
      for (const retro of incoming) {
        if (dispositions.get(retro.id) !== "create") continue;
        const normalized = importedRetro(retro, importedAt);
        await writeRetro(transaction, normalized, true);
        created.push(normalized.id);
      }
      return {
        batchNumber,
        status: created.length ? "applied" as const : "already-applied" as const,
        importedRetroIds: created,
        skippedRetroIds: skipped,
        conflictingRetroIds: conflicts
      };
    });
  } catch {
    return {
      batchNumber,
      status: "failed",
      importedRetroIds: [],
      skippedRetroIds: [],
      conflictingRetroIds: [],
      errorCode: "STORAGE_ERROR"
    };
  }
}

async function confirmImport(
  state: DurableObjectState,
  principal: AuthPrincipal,
  previewId: string,
  backup: BackupDocument
): Promise<Response> {
  if (!principal.isAdministrator) throw new BackendError("FORBIDDEN", "Only a configured administrator can import backups.");
  const backupHash = await hashBackup(backup);
  const previewKey = `${PREVIEW_PREFIX}${previewId}`;
  await state.storage.transaction(async (transaction) => {
    const value = await transaction.get<ImportPreviewRecord>(previewKey);
    if (
      !value ||
      value.actorId !== principal.actorId ||
      Date.parse(value.expiresAt) <= Date.now() ||
      value.backupHash !== backupHash
    ) {
      throw new BackendError("CONFLICT", "The import preview is missing, expired, or does not match this backup.");
    }
    await consumeActorMutationBudget(transaction, principal.actorId, Date.now());
  });

  const batchCount = Math.ceil(backup.retros.length / LIMITS.importBatchBoards);
  const importedAt = new Date().toISOString();
  const batches: ImportResult["batches"] = [];
  for (let index = 0; index < batchCount; index += 1) {
    const incoming = backup.retros.slice(
      index * LIMITS.importBatchBoards,
      (index + 1) * LIMITS.importBatchBoards
    );
    batches.push(await applyImportBatch(state, index + 1, incoming, importedAt));
  }
  const failedCount = batches.filter((batch) => batch.status === "failed").length;
  const completedBatchCount = batches.length - failedCount;
  const result = {
    completedBatchCount,
    remainingBatchCount: failedCount,
    batches,
    partialSuccess: failedCount > 0 && completedBatchCount > 0
  } satisfies ImportResult;
  return apiSuccess(result);
}

export async function handleImportPreview(
  state: DurableObjectState,
  principal: AuthPrincipal,
  request: Request
): Promise<Response> {
  if (!principal.isAdministrator) {
    throw new BackendError("FORBIDDEN", "Only a configured administrator can preview imports.");
  }
  const body = await readBoundedJson(request, LIMITS.bulkImportBytes, parseBackupPreviewBody);
  if (new TextEncoder().encode(JSON.stringify(body.backup)).byteLength > LIMITS.bulkImportBytes) {
    throw new BackendError("PAYLOAD_TOO_LARGE", "The backup document exceeds the 10 MiB import limit.");
  }
  return createPreview(state, principal, body.backup);
}

export async function handleImport(
  state: DurableObjectState,
  principal: AuthPrincipal,
  request: Request
): Promise<Response> {
  if (!principal.isAdministrator) {
    throw new BackendError("FORBIDDEN", "Only a configured administrator can import backups.");
  }
  const body = await readBoundedJson(request, LIMITS.bulkImportBytes, parseBackupImportBody);
  return confirmImport(state, principal, body.previewId, body.backup);
}

async function readBoundedJson<T>(
  request: Request,
  maximumBytes: number,
  parser: (value: unknown) => T
): Promise<T> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > maximumBytes) {
    throw new BackendError("PAYLOAD_TOO_LARGE", "The request body exceeds the 10 MiB import limit.");
  }
  if (!request.body) throw new BackendError("INVALID_REQUEST", "A JSON backup request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new BackendError("PAYLOAD_TOO_LARGE", "The request body exceeds the 10 MiB import limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BackendError("INVALID_REQUEST", "The backup request must contain valid JSON.");
  }
  return parser(value);
}

export async function exportRetro(
  storage: DurableObjectStorage,
  retroId: string
): Promise<Response> {
  const retro = await readRetro(storage, retroId);
  if (!retro) throw new BackendError("NOT_FOUND", "This retro does not exist.");
  return singleRetroExport(retro);
}

export async function exportAll(
  storage: DurableObjectStorage,
  url: URL
): Promise<Response> {
  const rawQuery = Object.fromEntries(url.searchParams.entries());
  const parsed = ExportAllQuerySchema.safeParse(rawQuery);
  if (!parsed.success) throw zodError(parsed.error);
  if (url.searchParams.size === 0) return streamAllRetros(storage);
  const cursor = parsed.data.cursor;
  const pageSize = parsed.data.pageSize ?? LIMITS.completedHistoryPageSize;
  return pagedExport(storage, cursor, pageSize);
}

export async function createImportPreviewFromBody(
  state: DurableObjectState,
  principal: AuthPrincipal,
  value: unknown
): Promise<Response> {
  const parsed = parseBackupPreviewBody(value);
  return createPreview(state, principal, parsed.backup);
}
