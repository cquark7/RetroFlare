import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ApiErrorResponseSchema } from "../src/shared/errors";

describe("production Worker authentication boundary in workerd", () => {
  it("fails closed on direct assets and API requests when production auth is unconfigured", async () => {
    for (const url of [
      "https://retroflare.test/",
      "https://retroflare.test/assets/index.js",
      "https://retroflare.test/api/me",
      "https://retroflare.test/api/retros"
    ]) {
      const response = await SELF.fetch(url);
      expect(response.status).toBe(503);
      expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe("SETUP_REQUIRED");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("does not enable a local bypass through DEV_AUTH, headers, query values, or local routes in a production build", async () => {
    const response = await SELF.fetch(
      "https://retroflare.test/api/me?DEV_AUTH=enabled&identity=alex",
      { headers: { "x-dev-auth": "enabled", "x-retroflare-principal": "{}" } }
    );
    expect(response.status).toBe(503);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe("SETUP_REQUIRED");

    const localEndpoint = await SELF.fetch("https://retroflare.test/api/local/identities");
    expect(localEndpoint.status).toBe(503);
  });

  it("rejects direct Durable Object requests without the Worker-replaced trusted principal", async () => {
    const bindings = env as unknown as Env;
    const objectId = bindings.TEAM_RETRO.idFromName(`direct-test-${crypto.randomUUID()}`);
    const stub = bindings.TEAM_RETRO.get(objectId);
    const response = await stub.fetch("https://team-retro.test/api/retros");
    expect(response.status).toBe(401);
    expect(ApiErrorResponseSchema.parse(await response.json()).error.code).toBe("AUTH_REQUIRED");
  });
});
