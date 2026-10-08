import { LIMITS } from "../../src/shared/constants";
import { AuthPrincipalSchema } from "../../src/shared/auth";
import type { AuthPrincipal } from "../../src/shared/auth";

export type LocalIdentity = { id: string; displayName: string };

export const LOCAL_IDENTITIES: readonly LocalIdentity[] = [
  { id: "alex", displayName: "Local Developer" },
  { id: "sam", displayName: "Sam Patel" },
  { id: "jordan", displayName: "Jordan Lee" },
  ...Array.from({ length: 15 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return { id: `user-${number}`, displayName: `Local User ${number}` };
  })
];

export type LocalDevelopmentEnvironment = Pick<
  Env,
  | "DEV_AUTH"
  | "DEV_ADMIN_IDENTITY"
  | "DEV_DEFAULT_IDENTITY"
  | "APP_ORIGIN"
>;

type LocalSession = { principal: AuthPrincipal; expiresAt: number };

const sessions = new Map<string, LocalSession>();
const SESSION_COOKIE = "retroflare_local_session";
const LOCAL_ISSUER = "local://retroflare-development";
// This namespace keeps existing local actors and their saved board ownership stable.
const LEGACY_ACTOR_NAMESPACE = "local://siq-retro-development";

function findIdentity(identityId: string | undefined): LocalIdentity | undefined {
  return LOCAL_IDENTITIES.find((identity) => identity.id === identityId);
}

async function actorIdFor(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${LEGACY_ACTOR_NAMESPACE}\u0000${subject}`)
  );
  return `local:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createLocalDevelopmentPrincipal(
  environment: LocalDevelopmentEnvironment,
  identityId = environment.DEV_DEFAULT_IDENTITY ?? "alex"
): Promise<AuthPrincipal | undefined> {
  if (environment.DEV_AUTH !== "enabled") return undefined;
  const identity = findIdentity(identityId);
  if (!identity) return undefined;

  const subject = `local-fixture:${identity.id}`;
  return AuthPrincipalSchema.parse({
    actorId: await actorIdFor(subject),
    subject,
    email: `${identity.id}@local.example.test`,
    emailDomain: "local.example.test",
    issuer: LOCAL_ISSUER,
    expiresAt: new Date(Date.now() + LIMITS.authSessionMs).toISOString(),
    isAdministrator: identity.id === (environment.DEV_ADMIN_IDENTITY ?? "alex"),
    authMethod: "local-development"
  });
}

export function getLocalIdentityForPrincipal(
  principal: AuthPrincipal
): LocalIdentity | undefined {
  if (
    principal.authMethod !== "local-development" ||
    principal.issuer !== LOCAL_ISSUER
  ) {
    return undefined;
  }
  const prefix = "local-fixture:";
  if (!principal.subject.startsWith(prefix)) return undefined;
  return findIdentity(principal.subject.slice(prefix.length));
}

export function getLocalSessionCookie(request: Request): string | undefined {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || undefined;
  }
  return undefined;
}

export async function resolveLocalDevelopmentPrincipal(
  request: Request,
  environment: LocalDevelopmentEnvironment,
  useDefaultWhenMissing: boolean
): Promise<AuthPrincipal | undefined> {
  if (environment.DEV_AUTH !== "enabled") return undefined;
  const cookie = getLocalSessionCookie(request);
  if (!cookie) {
    return useDefaultWhenMissing
      ? createLocalDevelopmentPrincipal(environment)
      : undefined;
  }

  const session = sessions.get(cookie);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(cookie);
    return undefined;
  }
  return session.principal;
}

export async function createLocalDevelopmentSession(
  environment: LocalDevelopmentEnvironment,
  identityId: string
): Promise<{ principal: AuthPrincipal; setCookie: string } | undefined> {
  const principal = await createLocalDevelopmentPrincipal(environment, identityId);
  if (!principal) return undefined;

  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(key);
  }
  while (sessions.size >= 100) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
  }

  const id = crypto.randomUUID();
  const expiresAt = now + LIMITS.authSessionMs;
  sessions.set(id, { principal, expiresAt });
  const secure = environment.APP_ORIGIN?.startsWith("https://") ? "; Secure" : "";
  return {
    principal,
    setCookie: `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(LIMITS.authSessionMs / 1000)}${secure}`
  };
}

export function localIdentityList(): LocalIdentity[] {
  return LOCAL_IDENTITIES.map(({ id, displayName }) => ({ id, displayName }));
}
