import { Hono } from "hono";
import { z } from "zod";
import { TEAM_OBJECT_NAME } from "../src/shared/constants";
import type { AuthPrincipal } from "../src/shared/auth";
import { MeDataSchema } from "../src/shared/api";
import { createApiError, ERROR_HTTP_STATUS } from "../src/shared/errors";
import type { ApiErrorCode } from "../src/shared/errors";
import { readAuthConfiguration, verifyAccessToken } from "./auth/access";
import { configuredApplicationOrigin, requestOriginMatches } from "./auth/request";
import {
  createLocalDevelopmentSession,
  getLocalIdentityForPrincipal,
  localIdentityList,
  resolveLocalDevelopmentPrincipal
} from "./auth/local-development";
import { TeamRetro } from "./TeamRetro";

declare const __RETROFLARE_LOCAL_DEVELOPMENT__: boolean;

type WorkerVariables = {
  principal: AuthPrincipal;
  appOrigin: string;
};

const app = new Hono<{ Bindings: Env; Variables: WorkerVariables }>();
const LocalSessionRequestSchema = z.object({ identity: z.string().min(1).max(32) }).strict();

function localDevelopmentBuildEnabled(): boolean {
  return (
    typeof __RETROFLARE_LOCAL_DEVELOPMENT__ !== "undefined" &&
    __RETROFLARE_LOCAL_DEVELOPMENT__ === true
  );
}

function responseError(
  code: ApiErrorCode,
  message: string,
  status = ERROR_HTTP_STATUS[code]
): Response {
  const error = createApiError(code, message, crypto.randomUUID());
  return Response.json(
    { ok: false, error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function originIsRequired(request: Request): boolean {
  const url = new URL(request.url);
  return (
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" ||
    (url.pathname.startsWith("/api/") &&
      request.method !== "GET" &&
      request.method !== "HEAD")
  );
}

async function resolveRequestPrincipal(
  request: Request,
  environment: Env,
  localBuild: boolean
): Promise<{ principal?: AuthPrincipal; appOrigin?: string; failure?: Response }> {
  if (localBuild) {
    if (environment.DEV_AUTH !== "enabled") {
      return {
        failure: responseError("SETUP_REQUIRED", "Local development authentication is not configured.")
      };
    }
    const appOrigin = configuredApplicationOrigin(request, environment.APP_ORIGIN, true);
    if (!appOrigin) {
      return {
        failure: responseError("FORBIDDEN", "This hostname is not configured for this application.")
      };
    }
    const path = new URL(request.url).pathname;
    const useDefaultIdentity =
      (path === "/api/local/session" && request.method === "POST") ||
      !request.headers.has("Cookie");
    const principal = await resolveLocalDevelopmentPrincipal(
      request,
      environment,
      useDefaultIdentity
    );
    if (!principal) {
      return { failure: responseError("AUTH_REQUIRED", "The local session is unavailable.") };
    }
    return { principal, appOrigin };
  }

  const configuration = readAuthConfiguration(environment);
  if (!configuration || environment.TEAM_OBJECT_NAME !== TEAM_OBJECT_NAME) {
    return {
      failure: responseError("SETUP_REQUIRED", "Application authentication is not configured.")
    };
  }

  const appOrigin = configuredApplicationOrigin(request, environment.APP_ORIGIN, false);
  if (!appOrigin || appOrigin !== configuration.appOrigin) {
    return {
      failure: responseError("FORBIDDEN", "This hostname is not configured for this application.")
    };
  }

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) {
    return { failure: responseError("AUTH_REQUIRED", "A valid Access session is required.") };
  }
  const principal = await verifyAccessToken(assertion, configuration);
  if (!principal) {
    return { failure: responseError("AUTH_REQUIRED", "A valid Access session is required.") };
  }
  return { principal, appOrigin };
}

app.use("*", async (context, next) => {
  const localBuild = localDevelopmentBuildEnabled();
  const { principal, appOrigin, failure } = await resolveRequestPrincipal(
    context.req.raw,
    context.env,
    localBuild
  );
  if (failure) return failure;
  if (!principal || !appOrigin) {
    return responseError("SETUP_REQUIRED", "Application authentication is not configured.");
  }
  if (!requestOriginMatches(context.req.raw, appOrigin, originIsRequired(context.req.raw))) {
    return responseError("FORBIDDEN", "The request origin is not allowed.");
  }
  context.set("principal", principal);
  context.set("appOrigin", appOrigin);
  return await next();
});

app.get("/api/me", (context) => {
  const principal = context.var.principal;
  const displayName =
    getLocalIdentityForPrincipal(principal)?.displayName ??
    principal.email.slice(0, principal.email.lastIndexOf("@"));
  const data = MeDataSchema.parse({
    actorId: principal.actorId,
    email: principal.email,
    displayName,
    isAdministrator: principal.isAdministrator,
    serverTime: new Date().toISOString(),
    sessionExpiresAt: principal.expiresAt
  });
  return Response.json(
    { ok: true, requestId: crypto.randomUUID(), data },
    { headers: { "Cache-Control": "no-store" } }
  );
});

app.get("/api/local/identities", (context) => {
  if (!localDevelopmentBuildEnabled() || context.env.DEV_AUTH !== "enabled") {
    return responseError("NOT_FOUND", "This endpoint is not available.");
  }
  const currentIdentity = getLocalIdentityForPrincipal(context.var.principal);
  return Response.json(
    {
      ok: true,
      requestId: crypto.randomUUID(),
      data: {
        identities: localIdentityList(),
        currentIdentity: currentIdentity?.id ?? "alex"
      }
    },
    { headers: { "Cache-Control": "no-store" } }
  );
});

app.post("/api/local/session", async (context) => {
  if (!localDevelopmentBuildEnabled() || context.env.DEV_AUTH !== "enabled") {
    return responseError("NOT_FOUND", "This endpoint is not available.");
  }
  let requestBody: unknown;
  try {
    const declaredLength = Number(context.req.header("Content-Length") ?? 0);
    if (declaredLength > 4_096) {
      return responseError("PAYLOAD_TOO_LARGE", "The local session request is too large.");
    }
    const text = await context.req.text();
    if (new TextEncoder().encode(text).byteLength > 4_096) {
      return responseError("PAYLOAD_TOO_LARGE", "The local session request is too large.");
    }
    requestBody = JSON.parse(text);
  } catch {
    return responseError("INVALID_REQUEST", "The local session request must be valid JSON.");
  }
  const parsed = LocalSessionRequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return responseError("INVALID_REQUEST", "Choose one of the configured local identities.");
  }
  const session = await createLocalDevelopmentSession(context.env, parsed.data.identity);
  if (!session) {
    return responseError("INVALID_REQUEST", "Choose one of the configured local identities.");
  }
  const identity = getLocalIdentityForPrincipal(session.principal);
  return Response.json(
    {
      ok: true,
      requestId: crypto.randomUUID(),
      data: { identity: identity?.id, displayName: identity?.displayName }
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": session.setCookie
      }
    }
  );
});

app.all("/api/*", async (context) => {
  const environment = context.env;
  if (environment.TEAM_OBJECT_NAME !== TEAM_OBJECT_NAME) {
    return responseError("SETUP_REQUIRED", "The stable team object is not configured.");
  }

  const headers = new Headers(context.req.raw.headers);
  headers.delete("x-retroflare-principal");
  headers.delete("Cf-Access-Jwt-Assertion");
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.set("x-retroflare-principal", JSON.stringify(context.var.principal));
  const internalRequest = new Request(context.req.raw, { headers });
  const objectId = environment.TEAM_RETRO.idFromName(TEAM_OBJECT_NAME);
  return environment.TEAM_RETRO.get(objectId).fetch(internalRequest);
});

app.all("*", async (context) => {
  const headers = new Headers(context.req.raw.headers);
  headers.delete("x-retroflare-principal");
  return context.env.ASSETS.fetch(new Request(context.req.raw, { headers }));
});

app.onError((error) => {
  void error;
  return responseError("INTERNAL_ERROR", "The request could not be completed.");
});

export { TeamRetro };

export default {
  async fetch(request: Request, environment: Env, executionContext: ExecutionContext): Promise<Response> {
    return app.fetch(request, environment, executionContext);
  }
} satisfies ExportedHandler<Env>;
