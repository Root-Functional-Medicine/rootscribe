// Shared helpers for Jira link construction. Kept in @applaud/shared so both
// the web UI and any future webhook consumers compute the same URL for the
// same (baseUrl, issueKey) pair.

export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

export function isValidJiraKey(key: string): boolean {
  return JIRA_KEY_PATTERN.test(key);
}

// Build a Jira issue URL from a base URL and issue key. Handles trailing
// slashes on either side so callers don't have to care about the exact shape
// the user typed into settings.
export function buildJiraUrl(baseUrl: string, issueKey: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  const trimmedKey = issueKey.trim();
  return `${trimmedBase}/${trimmedKey}`;
}
