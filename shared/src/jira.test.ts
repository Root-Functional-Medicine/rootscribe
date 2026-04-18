import { describe, expect, it } from "vitest";
import { JIRA_KEY_PATTERN, buildJiraUrl, isValidJiraKey } from "./jira.js";

describe("JIRA_KEY_PATTERN", () => {
  it.each([
    ["DEVX-100"],
    ["SS-1"],
    ["ABC-99999"],
    ["PROJ2-5"],
  ])("matches valid issue key %s", (key) => {
    expect(JIRA_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each([
    ["devx-100"],
    ["DEVX"],
    ["100"],
    ["DEVX-"],
    ["-100"],
    ["DEVX 100"],
    ["D-100"],
    [""],
  ])("rejects invalid issue key %s", (key) => {
    expect(JIRA_KEY_PATTERN.test(key)).toBe(false);
  });
});

describe("isValidJiraKey", () => {
  it("accepts canonical keys", () => {
    expect(isValidJiraKey("DEVX-100")).toBe(true);
  });

  it("rejects lowercase project prefixes", () => {
    expect(isValidJiraKey("devx-100")).toBe(false);
  });

  it("rejects single-letter prefixes (matches regex which requires 2+ chars)", () => {
    expect(isValidJiraKey("A-1")).toBe(false);
  });

  it("rejects non-numeric issue portion", () => {
    expect(isValidJiraKey("DEVX-abc")).toBe(false);
  });
});

describe("buildJiraUrl", () => {
  it("joins base and key with a single slash", () => {
    expect(buildJiraUrl("https://jira.example.com", "PROJ-1")).toBe(
      "https://jira.example.com/PROJ-1",
    );
  });

  it("strips trailing slashes from the base URL", () => {
    expect(buildJiraUrl("https://jira.example.com/", "PROJ-1")).toBe(
      "https://jira.example.com/PROJ-1",
    );
  });

  it("strips multiple trailing slashes from the base URL", () => {
    expect(buildJiraUrl("https://jira.example.com///", "PROJ-1")).toBe(
      "https://jira.example.com/PROJ-1",
    );
  });

  it("trims surrounding whitespace from the base URL and key", () => {
    expect(buildJiraUrl("  https://jira.example.com  ", "  PROJ-1  ")).toBe(
      "https://jira.example.com/PROJ-1",
    );
  });

  it("preserves paths in the base URL (e.g. /browse)", () => {
    expect(
      buildJiraUrl("https://company.atlassian.net/browse", "DEVX-100"),
    ).toBe("https://company.atlassian.net/browse/DEVX-100");
  });

  it("preserves paths even when the base URL has a trailing slash", () => {
    expect(
      buildJiraUrl("https://company.atlassian.net/browse/", "DEVX-100"),
    ).toBe("https://company.atlassian.net/browse/DEVX-100");
  });
});
