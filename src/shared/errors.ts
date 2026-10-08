import { z } from "zod";
import { UuidSchema } from "./domain";

export const ApiErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_REQUEST",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "SETUP_REQUIRED",
  "UNSUPPORTED_PROTOCOL",
  "RESYNC_REQUIRED",
  "INTERNAL_ERROR"
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorDetailsSchema = z
  .object({
    fieldErrors: z
      .array(
        z
          .object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string().max(240)
          })
          .strict()
      )
      .optional(),
    currentRevision: z.number().int().nonnegative().optional(),
    currentCardVersion: z.number().int().positive().optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    conflictingRetroIds: z.array(UuidSchema).optional()
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(240),
    requestId: UuidSchema,
    details: ApiErrorDetailsSchema.optional()
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: ApiErrorSchema
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  AUTH_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SETUP_REQUIRED: 503,
  UNSUPPORTED_PROTOCOL: 400,
  RESYNC_REQUIRED: 409,
  INTERNAL_ERROR: 500
};

export function createApiError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: ApiError["details"]
): ApiError {
  return ApiErrorSchema.parse({ code, message, requestId, details });
}
