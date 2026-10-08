import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { AuthConfiguration } from "../src/shared/auth";
import { readAuthConfiguration, verifyAccessToken } from "../worker/auth/access";

const issuer = "https://access.example.test";
const audience = "test-access-audience";
const configuration: AuthConfiguration = {
  allowedEmailDomain: "example.com",
  accessTeamIssuer: issuer,
  accessAudience: audience,
  appOrigin: "https://retro.example.com",
  administratorEmails: ["admin@example.com"]
};

async function createTestTokens() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({
    keys: [{ ...publicJwk, kid: "generated-test-key", alg: "RS256", use: "sig" }]
  });
  return {
    jwks,
    sign: async (
      claims: Record<string, unknown> = {},
      options: { issuer?: string; audience?: string; subject?: string; expiresAt?: number } = {}
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "generated-test-key" })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? audience)
        .setSubject(options.subject ?? "access-subject-42")
        .setIssuedAt()
        .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + 300)
        .sign(privateKey)
  };
}

describe("Cloudflare Access JWT authentication", () => {
  it("loads only a complete production configuration with an exact HTTPS origin", () => {
    expect(
      readAuthConfiguration({
        ALLOWED_EMAIL_DOMAIN: "Example.com",
        ACCESS_TEAM_ISSUER: issuer,
        ACCESS_AUD: audience,
        APP_ORIGIN: "https://retro.example.com/",
        ADMIN_EMAILS: "Admin@example.com, other@example.com"
      })
    ).toEqual({ ...configuration, administratorEmails: ["admin@example.com", "other@example.com"] });
    expect(readAuthConfiguration({ ACCESS_AUD: audience })).toBeUndefined();
    expect(
      readAuthConfiguration({
        ALLOWED_EMAIL_DOMAIN: "example.com",
        ACCESS_TEAM_ISSUER: issuer,
        ACCESS_AUD: audience,
        APP_ORIGIN: "http://retro.example.com"
      })
    ).toBeUndefined();
    expect(
      readAuthConfiguration({
        ALLOWED_EMAIL_DOMAIN: "example.com",
        ACCESS_TEAM_ISSUER: issuer,
        ACCESS_AUD: audience,
        APP_ORIGIN: "https://retro.example.com/path"
      })
    ).toBeUndefined();
  });

  it("verifies signature, issuer, audience, expiry, exact email domain, and server-only admin", async () => {
    const testKeys = await createTestTokens();
    const validToken = await testKeys.sign({ email: "ADMIN@EXAMPLE.COM" });
    const valid = await verifyAccessToken(
      validToken,
      configuration,
      testKeys.jwks
    );
    expect(valid).toMatchObject({
      email: "admin@example.com",
      emailDomain: "example.com",
      isAdministrator: true,
      authMethod: "cloudflare-access"
    });
    expect(valid?.actorId).toMatch(/^access:[0-9a-f]{64}$/);
    const [jwtHeader, jwtPayload, jwtSignature] = validToken.split(".");
    const forgedSignature = `${jwtSignature?.startsWith("A") ? "B" : "A"}${jwtSignature?.slice(1)}`;
    expect(
      await verifyAccessToken(`${jwtHeader}.${jwtPayload}.${forgedSignature}`, configuration, testKeys.jwks)
    ).toBeUndefined();
    expect(
      await verifyAccessToken(
        await testKeys.sign({ email: "user@example.com.evil.test" }),
        configuration,
        testKeys.jwks
      )
    ).toBeUndefined();
    expect(
      await verifyAccessToken(
        await testKeys.sign({ email: "user@evilexample.com" }),
        configuration,
        testKeys.jwks
      )
    ).toBeUndefined();
    expect(
      await verifyAccessToken(
        await testKeys.sign({ email: "user@example.com" }, { issuer: "https://forged.cloudflareaccess.com" }),
        configuration,
        testKeys.jwks
      )
    ).toBeUndefined();
    expect(
      await verifyAccessToken(
        await testKeys.sign({ email: "user@example.com" }, { audience: "different-audience" }),
        configuration,
        testKeys.jwks
      )
    ).toBeUndefined();
    expect(
      await verifyAccessToken(
        await testKeys.sign({ email: "user@example.com" }, { expiresAt: Math.floor(Date.now() / 1000) - 5 }),
        configuration,
        testKeys.jwks
      )
    ).toBeUndefined();
    expect(
      await verifyAccessToken(await testKeys.sign({ email: "user@example.com" }), configuration, testKeys.jwks)
    ).toMatchObject({ isAdministrator: false });
  });

  it("requires the signed token to contain a valid subject and email claim", async () => {
    const testKeys = await createTestTokens();
    expect(
      await verifyAccessToken(await testKeys.sign({ email: "" }), configuration, testKeys.jwks)
    ).toBeUndefined();
    expect(
      await verifyAccessToken(await testKeys.sign({ email: "missing-at-sign" }), configuration, testKeys.jwks)
    ).toBeUndefined();
    expect(
      await verifyAccessToken(
        await testKeys.sign({ email: "user@example.com" }, { subject: "" }),
        configuration,
        testKeys.jwks
      )
    ).toBeUndefined();
  });
});
