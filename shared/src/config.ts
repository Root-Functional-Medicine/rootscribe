export interface BindConfig {
  host: string;
  port: number;
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  secret?: string;
}

export interface AppConfig {
  version: number;
  setupComplete: boolean;
  token: string | null;
  tokenExp: number | null;
  tokenEmail: string | null;
  plaudRegion: string | null;
  recordingsDir: string | null;
  webhook: WebhookConfig | null;
  pollIntervalMinutes: number;
  bind: BindConfig;
  lanToken: string | null;
  // Base URL for auto-constructing Jira issue links. When a recording has a
  // Jira issue key but no explicit URL, the UI builds the full URL via
  // buildJiraUrl(baseUrl, key) — trailing slashes on either side are
  // normalized, so users can store it with or without one.
  jiraBaseUrl: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  setupComplete: false,
  token: null,
  tokenExp: null,
  tokenEmail: null,
  plaudRegion: null,
  recordingsDir: null,
  webhook: null,
  pollIntervalMinutes: 10,
  bind: { host: "127.0.0.1", port: 44471 },
  lanToken: null,
  jiraBaseUrl: "https://rootfunctionalmedicine.atlassian.net/browse/",
};
