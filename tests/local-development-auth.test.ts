import { describe, expect, it } from "vitest";
import {
  createLocalDevelopmentPrincipal,
  createLocalDevelopmentSession,
  getLocalIdentityForPrincipal,
  localIdentityList,
  resolveLocalDevelopmentPrincipal
} from "../worker/auth/local-development";

const localEnvironment = {
  DEV_AUTH: "enabled",
  DEV_DEFAULT_IDENTITY: "alex",
  DEV_ADMIN_IDENTITY: "alex",
  APP_ORIGIN: "http://localhost:5173"
};

describe("local-only identity adapter", () => {
  it("uses only the predefined identities and grants administrator status only to configured alex", async () => {
    const alex = await createLocalDevelopmentPrincipal(localEnvironment);
    const sam = await createLocalDevelopmentPrincipal(localEnvironment, "sam");

    expect(alex).toMatchObject({
      email: "alex@local.example.test",
      emailDomain: "local.example.test",
      authMethod: "local-development",
      isAdministrator: true
    });
    expect(sam).toMatchObject({
      email: "sam@local.example.test",
      isAdministrator: false
    });
    expect(alex?.actorId).not.toBe("alex");
    // Keep existing locally stored boards associated with the same demo actor.
    expect(alex?.actorId).toBe("local:7f8afb15e9f67bebe5d0cce9eb30ae0a57284446536e7640af54ff0eb350cbc8");
    expect(getLocalIdentityForPrincipal(alex!)).toEqual({ id: "alex", displayName: "Local Developer" });
    expect(localIdentityList()).toHaveLength(18);
    expect(await createLocalDevelopmentPrincipal(localEnvironment, "owner@company.test")).toBeUndefined();
    expect(await createLocalDevelopmentPrincipal({ ...localEnvironment, DEV_AUTH: "true" })).toBeUndefined();
    expect(await createLocalDevelopmentPrincipal({})).toBeUndefined();
  });

  it("issues an opaque strict cookie tied to the selected server fixture", async () => {
    const session = await createLocalDevelopmentSession(localEnvironment, "jordan");
    expect(session?.setCookie).toMatch(/^retroflare_local_session=[0-9a-f-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=14400$/);
    expect(session?.principal).toMatchObject({ email: "jordan@local.example.test", isAdministrator: false });

    const cookieValue = session!.setCookie.split(";")[0];
    const request = new Request("http://localhost:5173/api/me", {
      headers: { Cookie: cookieValue }
    });
    expect(await resolveLocalDevelopmentPrincipal(request, localEnvironment, false)).toEqual(session?.principal);
    expect(
      await resolveLocalDevelopmentPrincipal(
        new Request("http://localhost:5173/api/me", { headers: { Cookie: "retroflare_local_session=forged" } }),
        localEnvironment,
        false
      )
    ).toBeUndefined();
  });
});
