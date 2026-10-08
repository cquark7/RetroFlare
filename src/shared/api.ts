import { z } from "zod";
import { LIMITS, PROTOCOL_VERSION } from "./constants";
import {
  BackupDocumentSchema,
  BackupPageSchema,
  ImportPreviewDataSchema,
  ImportPreviewRequestSchema,
  ImportRequestSchema,
  ImportResultSchema
} from "./backup";
import {
  ActorIdSchema,
  DisplayNameSchema,
  IsoDateTimeSchema,
  ParticipantSchema,
  RetroSchema,
  RetroStatusSchema,
  RetroSummarySchema,
  RetroTitleSchema,
  UuidSchema
} from "./domain";
import { ApiErrorResponseSchema } from "./errors";
import { CommandFrameSchema, type ServerMessage } from "./protocol";

export const ApiSuccessSchema = <T extends z.ZodType>(dataSchema: T) =>
  z
    .object({
      ok: z.literal(true),
      requestId: UuidSchema,
      data: dataSchema
    })
    .strict();

export type ApiSuccess<T> = {
  ok: true;
  requestId: string;
  data: T;
};
export type ApiResponse<T> = ApiSuccess<T> | z.infer<typeof ApiErrorResponseSchema>;

export const MeDataSchema = z
  .object({
    actorId: ActorIdSchema,
    email: z.string().email().max(320),
    displayName: DisplayNameSchema,
    isAdministrator: z.boolean(),
    serverTime: IsoDateTimeSchema,
    sessionExpiresAt: IsoDateTimeSchema
  })
  .strict();
export type MeData = z.infer<typeof MeDataSchema>;
export const MeSuccessSchema = ApiSuccessSchema(MeDataSchema);

export const RetroListQuerySchema = z
  .object({
    status: RetroStatusSchema.optional(),
    cursor: z.string().min(1).max(512).optional(),
    pageSize: z.coerce.number().int().positive().max(LIMITS.completedHistoryPageSize).optional()
  })
  .strict();
export type RetroListQuery = z.infer<typeof RetroListQuerySchema>;

export const RetroListDataSchema = z
  .object({
    retros: z.array(RetroSummarySchema).max(LIMITS.completedHistoryPageSize),
    nextCursor: z.string().min(1).max(512).optional(),
    hasMore: z.boolean()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.hasMore && result.nextCursor === undefined) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "A page with more results needs a cursor."
      });
    }
  });
export type RetroListData = z.infer<typeof RetroListDataSchema>;
export const RetroListSuccessSchema = ApiSuccessSchema(RetroListDataSchema);

export const CreateRetroRequestSchema = z
  .object({
    title: RetroTitleSchema,
    displayName: DisplayNameSchema
  })
  .strict();
export type CreateRetroRequest = z.infer<typeof CreateRetroRequestSchema>;

export const CreateRetroDataSchema = z
  .object({
    retro: RetroSchema,
    summary: RetroSummarySchema
  })
  .strict();
export const CreateRetroSuccessSchema = ApiSuccessSchema(CreateRetroDataSchema);

export const RetroIdParamsSchema = z.object({ id: UuidSchema }).strict();

export const GetRetroDataSchema = z.object({ retro: RetroSchema }).strict();
export const GetRetroSuccessSchema = ApiSuccessSchema(GetRetroDataSchema);

export const JoinRetroRequestSchema = z
  .object({ displayName: DisplayNameSchema })
  .strict();
export type JoinRetroRequest = z.infer<typeof JoinRetroRequestSchema>;

export const JoinRetroDataSchema = z
  .object({
    retroId: UuidSchema,
    participant: ParticipantSchema
  })
  .strict();
export const JoinRetroSuccessSchema = ApiSuccessSchema(JoinRetroDataSchema);

export const WebSocketHandshakeQuerySchema = z
  .object({
    protocolVersion: z.coerce.number().int().positive().default(PROTOCOL_VERSION)
  })
  .strict();

export const PostCommandsRequestSchema = CommandFrameSchema;
export const PostCommandsDataSchema = z
  .object({
    acceptedCommandIds: z.array(UuidSchema),
    resultingRevision: z.number().int().nonnegative()
  })
  .strict();
export const PostCommandsSuccessSchema = ApiSuccessSchema(PostCommandsDataSchema);

export const SingleRetroBackupDocumentSchema = BackupDocumentSchema.superRefine(
  (backup, context) => {
    if (backup.retros.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["retros"],
        message: "A single-retro export must contain exactly one retro."
      });
    }
  }
);
export const SingleRetroExportSuccessSchema = ApiSuccessSchema(
  SingleRetroBackupDocumentSchema
);

export const ExportAllQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    pageSize: z.coerce.number().int().positive().max(LIMITS.completedHistoryPageSize).optional()
  })
  .strict();
export const ExportAllSuccessSchema = ApiSuccessSchema(BackupPageSchema);

export const ImportPreviewRequestBodySchema = ImportPreviewRequestSchema;
export const ImportPreviewSuccessSchema = ApiSuccessSchema(ImportPreviewDataSchema);
export const ImportRequestBodySchema = ImportRequestSchema;
export const ImportSuccessSchema = ApiSuccessSchema(ImportResultSchema);

export const API_ROUTES = {
  me: { method: "GET", path: "/api/me" },
  retros: { method: "GET", path: "/api/retros" },
  createRetro: { method: "POST", path: "/api/retros" },
  retro: { method: "GET", path: "/api/retros/:id" },
  joinRetro: { method: "POST", path: "/api/retros/:id/join" },
  retroWebSocket: { method: "GET", path: "/api/retros/:id/ws" },
  commands: { method: "POST", path: "/api/retros/:id/commands" },
  exportRetro: { method: "GET", path: "/api/retros/:id/export" },
  exportAll: { method: "GET", path: "/api/export" },
  importPreview: { method: "POST", path: "/api/import/preview" },
  import: { method: "POST", path: "/api/import" }
} as const;

export type HttpRouteContracts = {
  "GET /api/me": { request: undefined; response: z.infer<typeof MeSuccessSchema> };
  "GET /api/retros": { query: RetroListQuery; response: z.infer<typeof RetroListSuccessSchema> };
  "POST /api/retros": {
    body: CreateRetroRequest;
    response: z.infer<typeof CreateRetroSuccessSchema>;
  };
  "GET /api/retros/:id": {
    params: z.infer<typeof RetroIdParamsSchema>;
    response: z.infer<typeof GetRetroSuccessSchema>;
  };
  "POST /api/retros/:id/join": {
    params: z.infer<typeof RetroIdParamsSchema>;
    body: JoinRetroRequest;
    response: z.infer<typeof JoinRetroSuccessSchema>;
  };
  "GET /api/retros/:id/ws": {
    params: z.infer<typeof RetroIdParamsSchema>;
    query: z.input<typeof WebSocketHandshakeQuerySchema>;
    response: ServerMessage;
  };
  "POST /api/retros/:id/commands": {
    params: z.infer<typeof RetroIdParamsSchema>;
    body: z.infer<typeof PostCommandsRequestSchema>;
    response: z.infer<typeof PostCommandsSuccessSchema>;
  };
  "GET /api/retros/:id/export": {
    params: z.infer<typeof RetroIdParamsSchema>;
    response: z.infer<typeof SingleRetroExportSuccessSchema>;
  };
  "GET /api/export": {
    query: z.infer<typeof ExportAllQuerySchema>;
    response: z.infer<typeof ExportAllSuccessSchema>;
  };
  "POST /api/import/preview": {
    body: z.infer<typeof ImportPreviewRequestBodySchema>;
    response: z.infer<typeof ImportPreviewSuccessSchema>;
  };
  "POST /api/import": {
    body: z.infer<typeof ImportRequestBodySchema>;
    response: z.infer<typeof ImportSuccessSchema>;
  };
};
