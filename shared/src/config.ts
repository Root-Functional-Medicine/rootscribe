export interface BindConfig {
  host: string;
  port: number;
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  // Shared secret used to HMAC-SHA256 sign outbound deliveries. When set,
  // every webhook carries `x-rootscribe-signature` + `x-rootscribe-timestamp`
  // so receivers can verify origin. Never sent as a header itself, and never
  // returned by GET/POST /api/config (the API has no auth and may be bound
  // to 0.0.0.0) — clients see `secretConfigured` instead. On POST the field
  // is tri-state: omitted = keep the stored secret, "" = clear it, non-empty
  // = replace it.
  secret?: string;
  // Response-only: whether a secret is stored. The server strips it from
  // incoming patches (Zod drops unknown keys) and never persists it.
  secretConfigured?: boolean;
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
  // Stable identifier for this RootScribe install, sent as
  // `x-rootscribe-instance` on every outbound webhook so one receiver can tell
  // several developers' instances apart. Generated once (UUID) on first run
  // by the server; editable in Settings. Null only until the server has
  // booted for the first time.
  instanceId: string | null;
}

// `instanceId` is stamped verbatim into the `x-rootscribe-instance` header,
// so it must be a conservative header-safe token: undici's fetch throws on
// control characters / non-Latin-1 bytes (which would break EVERY delivery),
// and spaces make the value awkward to match on the receiving side. Enforced
// on API input (POST /api/config) AND on the persisted value (the server
// re-mints a UUID when a hand-edited settings.json fails this check).
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID_PATTERN.test(value);
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
  instanceId: null,
};
