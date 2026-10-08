import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { AuthConfigurationSchema, AuthPrincipalSchema } from "../../src/shared/auth";
import type { AuthConfiguration, AuthPrincipal } from "../../src/shared/auth";

type AuthEnvironment = Pick<
  Env,
  | "ALLOWED_EMAIL_DOMAIN"
  | "ACCESS_TEAM_ISSUER"
  | "ACCESS_AUD"
  | "APP_ORIGIN"
  | "ADMIN_EMAILS"
>;

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function normalizeIssuer(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function readAuthConfiguration(
  environment: AuthEnvironment
): AuthConfiguration | undefined {
  const domain = environment.ALLOWED_EMAIL_DOMAIN?.trim();
  const issuer = environment.ACCESS_TEAM_ISSUER?.trim();
  const audience = environment.ACCESS_AUD?.trim();
  const origin = environment.APP_ORIGIN?.trim();
  if (!domain || !issuer || !audience || !origin) return undefined;

  const normalizedIssuer = normalizeIssuer(issuer);
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedIssuer || !normalizedOrigin) return undefined;

  const administratorEmails = (environment.ADMIN_EMAILS ?? "")
    .split(/[\s,]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const parsed = AuthConfigurationSchema.safeParse({
    allowedEmailDomain: normalizeDomain(domain),
    accessTeamIssuer: normalizedIssuer,
    accessAudience: audience,
    appOrigin: normalizedOrigin,
    administratorEmails
  });
  return parsed.success ? parsed.data : undefined;
}

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

function actorIdFor(issuer: string, subject: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(`${issuer}\u0000${subject}`))
    .then((digest) => {
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      return `access:${hex}`;
    });
}

export async function verifyAccessToken(
  token: string,
  configuration: AuthConfiguration,
  keyResolver: JWTVerifyGetKey = getJwks(
    configuration.accessTeamIssuer
  )
): Promise<AuthPrincipal | undefined> {
  try {
    const { payload } = await jwtVerify(token, keyResolver, {
      issuer: configuration.accessTeamIssuer,
      audience: configuration.accessAudience,
      algorithms: ["RS256"]
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub.trim() ||
      typeof payload.email !== "string" ||
      !Number.isFinite(payload.exp) ||
      payload.exp === undefined ||
      payload.exp * 1000 <= Date.now()
    ) {
      return undefined;
    }

    const email = payload.email.trim().toLowerCase();
    const separator = email.lastIndexOf("@");
    if (separator <= 0 || separator === email.length - 1) return undefined;
    const emailDomain = email.slice(separator + 1);
    if (emailDomain !== configuration.allowedEmailDomain.toLowerCase()) {
      return undefined;
    }

    const issuer = configuration.accessTeamIssuer;
    const isAdministrator = configuration.administratorEmails.some(
      (administrator) => administrator.toLowerCase() === email
    );
    return AuthPrincipalSchema.parse({
      actorId: await actorIdFor(issuer, payload.sub),
      subject: payload.sub,
      email,
      emailDomain,
      issuer,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      isAdministrator,
      authMethod: "cloudflare-access"
    });
  } catch {
    return undefined;
  }
}
