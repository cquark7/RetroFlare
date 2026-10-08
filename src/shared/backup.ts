import { z } from "zod";
import { BACKUP_EXPORT_VERSION, BACKUP_FORMAT, LIMITS } from "./constants";
import { RetroSchema, RetroStatusSchema, UuidSchema } from "./domain";

// Previous exports remain importable, but new exports use the current name.
const LEGACY_BACKUP_FORMAT = "siq-retro-backup";
const BackupHeaderShape = {
  format: z.enum([BACKUP_FORMAT, LEGACY_BACKUP_FORMAT]),
  exportVersion: z.union([z.literal(3), z.literal(BACKUP_EXPORT_VERSION)]),
  exportedAt: z.string().datetime(),
  sourceApplicationVersion: z.string().min(1).max(64)
};

export const BackupDocumentSchema = z
  .object({
    ...BackupHeaderShape,
    retros: z.array(RetroSchema)
  })
  .strict()
  .superRefine((backup, context) => {
    const ids = new Set<string>();
    for (const [index, retro] of backup.retros.entries()) {
      if (ids.has(retro.id)) {
        context.addIssue({
          code: "custom",
          path: ["retros", index, "id"],
          message: "A backup cannot contain the same retro ID more than once."
        });
      }
      ids.add(retro.id);
    }
  });
export type BackupDocument = z.infer<typeof BackupDocumentSchema>;

export const BackupPageSchema = z
  .object({
    ...BackupHeaderShape,
    retros: z.array(RetroSchema).max(LIMITS.completedHistoryPageSize),
    nextCursor: z.string().min(1).max(512).optional(),
    hasMore: z.boolean()
  })
  .strict()
  .superRefine((page, context) => {
    if (page.hasMore && page.nextCursor === undefined) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "An export page with more entries needs a cursor."
      });
    }
  });
export type BackupPage = z.infer<typeof BackupPageSchema>;

export const ImportPreviewRequestSchema = z
  .object({ backup: BackupDocumentSchema })
  .strict();
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequestSchema>;

export const ImportDispositionSchema = z.enum(["create", "skip-identical", "id-conflict"]);

export const ImportPreviewItemSchema = z
  .object({
    retroId: UuidSchema,
    title: z.string().min(1).max(120),
    incomingStatus: RetroStatusSchema,
    disposition: ImportDispositionSchema,
    importedStatus: z.literal("closed"),
    batchNumber: z.number().int().positive()
  })
  .strict();

export const ImportPreviewReportSchema = z
  .object({
    boardCount: z.number().int().nonnegative(),
    createCount: z.number().int().nonnegative(),
    skipIdenticalCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    batchCount: z.number().int().nonnegative(),
    items: z.array(ImportPreviewItemSchema)
  })
  .strict()
  .superRefine((report, context) => {
    if (report.boardCount !== report.items.length) {
      context.addIssue({
        code: "custom",
        path: ["boardCount"],
        message: "The report count must match its item list."
      });
    }
    const expectedCreates = report.items.filter((item) => item.disposition === "create").length;
    const expectedSkips = report.items.filter((item) => item.disposition === "skip-identical").length;
    const expectedConflicts = report.items.filter((item) => item.disposition === "id-conflict").length;
    if (
      report.createCount !== expectedCreates ||
      report.skipIdenticalCount !== expectedSkips ||
      report.conflictCount !== expectedConflicts
    ) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Disposition totals must match the report items."
      });
    }

    const expectedBatchCount = Math.ceil(report.boardCount / LIMITS.importBatchBoards);
    if (report.batchCount !== expectedBatchCount) {
      context.addIssue({
        code: "custom",
        path: ["batchCount"],
        message: `Import batches must contain at most ${LIMITS.importBatchBoards} boards.`
      });
    }

    const boardsPerBatch = new Map<number, number>();
    for (const [index, item] of report.items.entries()) {
      if (item.batchNumber > report.batchCount) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "batchNumber"],
          message: "An item cannot reference a missing import batch."
        });
      }
      boardsPerBatch.set(item.batchNumber, (boardsPerBatch.get(item.batchNumber) ?? 0) + 1);
    }
    for (const [batchNumber, count] of boardsPerBatch) {
      if (count > LIMITS.importBatchBoards) {
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: `Import batch ${batchNumber} contains more than ${LIMITS.importBatchBoards} boards.`
        });
      }
    }
  });
export type ImportPreviewReport = z.infer<typeof ImportPreviewReportSchema>;

export const ImportPreviewDataSchema = z
  .object({
    previewId: UuidSchema,
    report: ImportPreviewReportSchema
  })
  .strict();
export type ImportPreviewData = z.infer<typeof ImportPreviewDataSchema>;

export const ImportRequestSchema = z
  .object({
    previewId: UuidSchema,
    confirmation: z.literal("append-only-import"),
    backup: BackupDocumentSchema
  })
  .strict();
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const ImportBatchResultSchema = z
  .object({
    batchNumber: z.number().int().positive(),
    status: z.enum(["applied", "already-applied", "failed"]),
    importedRetroIds: z.array(UuidSchema),
    skippedRetroIds: z.array(UuidSchema),
    conflictingRetroIds: z.array(UuidSchema),
    errorCode: z.enum(["STORAGE_ERROR", "CONFLICT"]).optional()
  })
  .strict();

export const ImportResultSchema = z
  .object({
    completedBatchCount: z.number().int().nonnegative(),
    remainingBatchCount: z.number().int().nonnegative(),
    batches: z.array(ImportBatchResultSchema),
    partialSuccess: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    const failures = result.batches.filter((batch) => batch.status === "failed").length;
    if (result.partialSuccess !== (failures > 0 && result.completedBatchCount > 0)) {
      context.addIssue({
        code: "custom",
        path: ["partialSuccess"],
        message: "Partial success must reflect completed and failed batches."
      });
    }
  });
export type ImportResult = z.infer<typeof ImportResultSchema>;

export function isWithinBulkImportLimit(serializedBackup: string): boolean {
  return new TextEncoder().encode(serializedBackup).byteLength <= LIMITS.bulkImportBytes;
}
