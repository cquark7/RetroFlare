import { createApiError, ERROR_HTTP_STATUS } from "../src/shared/errors";
import type { ApiError, ApiErrorCode } from "../src/shared/errors";

export class BackendError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: ApiError["details"];

  constructor(code: ApiErrorCode, message: string, details?: ApiError["details"]) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(error: unknown): Response {
  const requestId = crypto.randomUUID();
  if (error instanceof BackendError) {
    const apiError = createApiError(error.code, error.message, requestId, error.details);
    return Response.json(
      { ok: false, error: apiError },
      { status: ERROR_HTTP_STATUS[error.code], headers: { "Cache-Control": "no-store" } }
    );
  }
  const apiError = createApiError("INTERNAL_ERROR", "The request could not be completed.", requestId);
  return Response.json(
    { ok: false, error: apiError },
    { status: 500, headers: { "Cache-Control": "no-store" } }
  );
}

export function apiSuccess<T>(data: T): Response {
  return Response.json(
    { ok: true, requestId: crypto.randomUUID(), data },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export function parseJsonRequestBody<T>(
  request: Request,
  maximumBytes: number,
  parser: (value: unknown) => T
): Promise<T> {
  return (async () => {
    const declared = request.headers.get("Content-Length");
    if (declared && Number.isFinite(Number(declared)) && Number(declared) > maximumBytes) {
      throw new BackendError("PAYLOAD_TOO_LARGE", "The request body exceeds the allowed size.");
    }
    if (!request.body) throw new BackendError("INVALID_REQUEST", "A JSON request body is required.");

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
          throw new BackendError("PAYLOAD_TOO_LARGE", "The request body exceeds the allowed size.");
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
      throw new BackendError("INVALID_REQUEST", "The request body must contain valid JSON.");
    }
    try {
      return parser(value);
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError("INVALID_REQUEST", "The request body does not match the required schema.");
    }
  })();
}

export function zodError(error: unknown): BackendError {
  const issues =
    error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? error.issues
      : [];
  return new BackendError(
    "INVALID_REQUEST",
    "The request does not match the required schema.",
    {
      fieldErrors: issues.slice(0, 30).map((issue: { path?: (string | number)[]; message?: string }) => ({
        path: issue.path ?? [],
        message: (issue.message ?? "Invalid value.").slice(0, 240)
      }))
    }
  );
}
