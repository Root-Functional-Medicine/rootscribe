import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, isValidInstanceId } from "./config.js";

describe("DEFAULT_CONFIG", () => {
  it("starts with setup incomplete so the wizard runs on first boot", () => {
    expect(DEFAULT_CONFIG.setupComplete).toBe(false);
  });

  it("has no token, email, or region until the user authenticates", () => {
    expect(DEFAULT_CONFIG.token).toBeNull();
    expect(DEFAULT_CONFIG.tokenExp).toBeNull();
    expect(DEFAULT_CONFIG.tokenEmail).toBeNull();
    expect(DEFAULT_CONFIG.plaudRegion).toBeNull();
  });

  it("binds to loopback on port 44471 by default", () => {
    expect(DEFAULT_CONFIG.bind).toEqual({ host: "127.0.0.1", port: 44471 });
  });

  it("polls Plaud every 10 minutes by default", () => {
    expect(DEFAULT_CONFIG.pollIntervalMinutes).toBe(10);
  });

  it("leaves the webhook unconfigured so users opt into outbound calls", () => {
    expect(DEFAULT_CONFIG.webhook).toBeNull();
  });

  it("provides a sensible default Jira base URL pointing at Atlassian Cloud", () => {
    expect(DEFAULT_CONFIG.jiraBaseUrl).toMatch(
      /^https:\/\/[\w-]+\.atlassian\.net\/browse\/$/,
    );
  });
});

describe("DEFAULT_CONFIG.instanceId", () => {
  it("is null until the server generates one on first run", () => {
    // The server mints a UUID and persists it the first time it boots
    // (ensureInstanceId); shared defaults must not bake in a fixed value
    // or every install would share the same identifier.
    expect(DEFAULT_CONFIG.instanceId).toBeNull();
  });
});

describe("isValidInstanceId", () => {
  it("accepts a header-safe token of 1..128 chars", () => {
    expect(isValidInstanceId("allen-macbook.local:1")).toBe(true);
    expect(isValidInstanceId("a".repeat(128))).toBe(true);
  });

  it("rejects trailing line terminators — `$` must anchor at end of input, never before a final newline", () => {
    // Copilot review on PR #19 round 4 asked for this guard. In JavaScript a
    // non-multiline `$` only matches at end of input (unlike Perl/Python),
    // so these already fail; the test pins that so a future `m` flag or a
    // rewrite to a Python-style check can't reopen the hole.
    const rejected = ["safe\n", "safe\r", "safe\r\n", "safe\u2028", "safe\u2029", "\nsafe"].filter(
      (bad) => !isValidInstanceId(bad),
    );
    expect(rejected).toHaveLength(6);
  });

  it("rejects empty, over-long, non-string, and unsafe-character values", () => {
    expect(isValidInstanceId("")).toBe(false);
    expect(isValidInstanceId("a".repeat(129))).toBe(false);
    expect(isValidInstanceId(42)).toBe(false);
    expect(isValidInstanceId(null)).toBe(false);
    expect(isValidInstanceId("two words")).toBe(false);
  });
});
