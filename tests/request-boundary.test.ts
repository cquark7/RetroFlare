import { describe, expect, it } from "vitest";
import {
  configuredApplicationOrigin,
  requestOriginMatches
} from "../worker/auth/request";

describe("application host and Origin boundary", () => {
  it("accepts only the configured exact hostname and scheme", () => {
    const exact = new Request("https://retro.example.com/api/me", {
      headers: { Host: "retro.example.com" }
    });
    expect(configuredApplicationOrigin(exact, "https://retro.example.com", false)).toBe(
      "https://retro.example.com"
    );
    expect(
      configuredApplicationOrigin(
        new Request("https://retro.example.com.evil.test/api/me"),
        "https://retro.example.com",
        false
      )
    ).toBeUndefined();
    expect(
      configuredApplicationOrigin(
        new Request("https://evilretro.example.com/api/me"),
        "https://retro.example.com",
        false
      )
    ).toBeUndefined();
    expect(
      configuredApplicationOrigin(
        new Request("http://retro.example.com/api/me"),
        "https://retro.example.com",
        false
      )
    ).toBeUndefined();
    expect(
      configuredApplicationOrigin(
        new Request("https://retro.example.com/api/me", { headers: { Host: "retro.example.com.evil.test" } }),
        "https://retro.example.com",
        false
      )
    ).toBeUndefined();
  });

  it("requires exact Origin for mutations and WebSocket upgrades, and rejects foreign Origins on reads", () => {
    const expected = "https://retro.example.com";
    expect(
      requestOriginMatches(
        new Request("https://retro.example.com/api/retros", { method: "POST", headers: { Origin: expected } }),
        expected,
        true
      )
    ).toBe(true);
    expect(
      requestOriginMatches(
        new Request("https://retro.example.com/api/retros", { method: "POST" }),
        expected,
        true
      )
    ).toBe(false);
    expect(
      requestOriginMatches(
        new Request("https://retro.example.com/api/retros", {
          method: "POST",
          headers: { Origin: "https://retro.example.com.evil.test" }
        }),
        expected,
        true
      )
    ).toBe(false);
    expect(
      requestOriginMatches(
        new Request("https://retro.example.com/api/me", {
          headers: { Origin: "https://other.example.com" }
        }),
        expected,
        false
      )
    ).toBe(false);
  });
});
