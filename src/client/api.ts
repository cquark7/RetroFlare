import {
  ApiSuccessSchema,
  CreateRetroDataSchema,
  GetRetroDataSchema,
  JoinRetroDataSchema,
  MeDataSchema,
  PostCommandsDataSchema,
  RetroListDataSchema,
  SingleRetroBackupDocumentSchema,
  type CreateRetroRequest
} from "../shared/api";
import {
  BackupDocumentSchema,
  BackupPageSchema,
  ImportPreviewDataSchema,
  ImportPreviewRequestSchema,
  ImportResultSchema,
  isWithinBulkImportLimit,
  type BackupDocument,
  type ImportPreviewData,
  type ImportRequest,
  type ImportResult
} from "../shared/backup";
import type { Retro } from "../shared/domain";
import { ApiErrorResponseSchema, type ApiError } from "../shared/errors";
import { z } from "zod";

export class ApiRequestError extends Error {
  readonly code: ApiError["code"];
  readonly details: ApiError["details"];
  readonly requestId: string;
  readonly status: number;

  constructor(error: ApiError, status: number) {
    super(error.message);
    this.name = "ApiRequestError";
    this.code = error.code;
    this.details = error.details;
    this.requestId = error.requestId;
    this.status = status;
  }
}

export function userSafeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {}
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
  } catch {
    throw new Error("You’re offline. Your unsaved changes are kept on this device.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 401 || response.status === 403 || response.redirected || response.headers.get("Content-Type")?.includes("text/html")) {
      throw new ApiRequestError(
        { code: "AUTH_REQUIRED", message: "Your session needs attention. Sign in again to continue.", requestId: crypto.randomUUID() },
        response.status
      );
    }
    throw new Error(response.ok ? "The server returned an unreadable response." : `Request failed (${response.status}).`);
  }

  if (!response.ok) {
    const parsedError = ApiErrorResponseSchema.safeParse(body);
    if (parsedError.success) throw new ApiRequestError(parsedError.data.error, response.status);
    throw new Error(`Request failed (${response.status}).`);
  }

  return ApiSuccessSchema(schema).parse(body).data;
}

export const api = {
  me: () => request("/api/me", MeDataSchema),

  retros: (status: "open" | "closing" | "closed", cursor?: string) => {
    const query = new URLSearchParams({ status, pageSize: "25" });
    if (cursor) query.set("cursor", cursor);
    return request(`/api/retros?${query}`, RetroListDataSchema);
  },

  retro: async (id: string): Promise<Retro> => {
    const data = await request(`/api/retros/${encodeURIComponent(id)}`, GetRetroDataSchema);
    return data.retro;
  },

  createRetro: (body: CreateRetroRequest) =>
    request("/api/retros", CreateRetroDataSchema, { method: "POST", body: JSON.stringify(body) }),

  joinRetro: (id: string, displayName: string) =>
    request(`/api/retros/${encodeURIComponent(id)}/join`, JoinRetroDataSchema, {
      method: "POST",
      body: JSON.stringify({ displayName })
    }),

  commandFrame: async (id: string, frame: unknown) => {
    const response = await request(`/api/retros/${encodeURIComponent(id)}/commands`,
      PostCommandsDataSchema,
      { method: "POST", body: JSON.stringify(frame) });
    return response;
  },

  exportRetro: async (id: string): Promise<BackupDocument> => {
    const response = await fetch(`/api/retros/${encodeURIComponent(id)}/export`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = ApiErrorResponseSchema.safeParse(body);
      if (error.success) throw new ApiRequestError(error.data.error, response.status);
      throw new Error(`Export failed (${response.status}).`);
    }
    return SingleRetroBackupDocumentSchema.parse(body);
  },

  exportAllPages: async function* () {
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: "25" });
      if (cursor) query.set("cursor", cursor);
      const page = await request(`/api/export?${query}`, BackupPageSchema);
      yield page;
      cursor = page.hasMore ? page.nextCursor : undefined;
    } while (cursor);
  },

  importPreview: async (backup: BackupDocument): Promise<ImportPreviewData> => {
    const body = ImportPreviewRequestSchema.parse({ backup });
    return request("/api/import/preview", ImportPreviewDataSchema, {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  importBackup: (body: ImportRequest): Promise<ImportResult> =>
    request("/api/import", ImportResultSchema, { method: "POST", body: JSON.stringify(body) })
};

const LocalIdentityListSchema = z.object({
  identities: z.array(z.object({ id: z.string().min(1), displayName: z.string().min(1) }).strict()),
  currentIdentity: z.string().min(1)
}).strict();

export type LocalIdentityList = z.infer<typeof LocalIdentityListSchema>;

export async function getLocalIdentities(): Promise<LocalIdentityList> {
  return request("/api/local/identities", LocalIdentityListSchema);
}

export async function switchLocalIdentity(identity: string): Promise<void> {
  await request("/api/local/session", z.unknown(), { method: "POST", body: JSON.stringify({ identity }) });
}

export async function parseBackupFile(file: File): Promise<BackupDocument> {
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("This backup is larger than the 10 MiB import limit.");
  }
  const text = await file.text();
  if (!isWithinBulkImportLimit(text)) {
    throw new Error("This backup is larger than the 10 MiB import limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("That file isn’t valid JSON.");
  }
  return BackupDocumentSchema.parse(value);
}
