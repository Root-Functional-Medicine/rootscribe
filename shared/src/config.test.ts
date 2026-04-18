import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";

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
