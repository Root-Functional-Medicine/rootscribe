import type {
  AuthDetectResponse,
  AuthValidateResponse,
  ConfigResponse,
  RecordingsListResponse,
  RecordingDetailResponse,
  InboxMutationResponse,
  SyncStatusResponse,
  SetupStatusResponse,
  WebhookTestResponse,
  RecordingsDirValidateResponse,
  AppConfig,
  InboxStatus,
  RecordingsListFilter,
} from "@applaud/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

// Normalize assorted server error shapes into a single human-readable string.
// Handles plain strings, Zod `flatten()` output, and shallow objects with a
// nested `message` / `error` field.
function extractErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  // Zod flatten(): { formErrors: string[], fieldErrors: Record<string, string[]> }
  const formErrors = obj["formErrors"];
  const fieldErrors = obj["fieldErrors"];
  const parts: string[] = [];
  if (Array.isArray(formErrors)) {
    for (const e of formErrors) if (typeof e === "string") parts.push(e);
  }
  if (fieldErrors && typeof fieldErrors === "object") {
    for (const [field, errs] of Object.entries(fieldErrors)) {
      if (Array.isArray(errs)) {
        for (const e of errs) if (typeof e === "string") parts.push(`${field}: ${e}`);
      }
    }
  }
  if (parts.length > 0) return parts.join("; ");
  const nested = extractErrorMessage(obj["message"]) ?? extractErrorMessage(obj["error"]);
  return nested;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Endpoints return `{ error: string }` for plain failures and
    // `{ error: <object> }` for Zod validation failures (zod's flatten()
    // shape: { formErrors: string[], fieldErrors: Record<string, string[]> }).
    // Surface the most useful string we can extract from either shape so the
    // UI renders a readable message instead of raw JSON.
    const body = await res.text().catch(() => "");
    const contentType = res.headers.get("content-type") ?? "";
    let message = body || `HTTP ${res.status}`;
    if (contentType.includes("application/json") && body) {
      try {
        const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
        const extracted = extractErrorMessage(parsed.error) ?? extractErrorMessage(parsed.message);
        if (extracted) message = extracted;
      } catch {
        // Fall back to raw body text if JSON parse fails.
      }
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface ListRecordingsParams {
  limit?: number;
  offset?: number;
  search?: string;
  filter?: RecordingsListFilter;
  tag?: string;
  category?: string;
  // Include availableTags/availableCategories in the response. Pay the extra
  // DISTINCT scans only when the caller actually needs the autocomplete data.
  facets?: boolean;
}

export const api = {
  setupStatus: () => jsonFetch<SetupStatusResponse>("/api/setup/status"),
  authDetect: () =>
    jsonFetch<AuthDetectResponse>("/api/auth/detect", { method: "POST", body: "{}" }),
  authAccept: (token: string, email?: string) =>
    jsonFetch<{ ok: boolean; email?: string; exp?: number; error?: string }>(
      "/api/auth/accept",
      {
        method: "POST",
        body: JSON.stringify({ token, ...(email ? { email } : {}) }),
      },
    ),
  authValidate: (token: string) =>
    jsonFetch<AuthValidateResponse>("/api/auth/validate", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  authStartWatch: () =>
    jsonFetch<{ watchId: string }>("/api/auth/watch", { method: "POST", body: "{}" }),
  config: () => jsonFetch<ConfigResponse>("/api/config"),
  updateConfig: (patch: Partial<AppConfig>) =>
    jsonFetch<ConfigResponse>("/api/config", {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  testWebhook: (url: string) =>
    jsonFetch<WebhookTestResponse>("/api/config/test-webhook", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  validateRecordingsDir: (pathStr: string) =>
    jsonFetch<RecordingsDirValidateResponse>("/api/config/validate-recordings-dir", {
      method: "POST",
      body: JSON.stringify({ path: pathStr }),
    }),
  completeSetup: () =>
    jsonFetch<{ ok: boolean }>("/api/config/complete-setup", {
      method: "POST",
      body: "{}",
    }),
  listRecordings: (params: ListRecordingsParams = {}) => {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.search) qs.set("search", params.search);
    if (params.filter) qs.set("filter", params.filter);
    if (params.tag) qs.set("tag", params.tag);
    if (params.category) qs.set("category", params.category);
    if (params.facets) qs.set("facets", "1");
    // Skip the `?` entirely when no params are set so `/api/recordings` and
    // `/api/recordings?foo=bar` stay distinct cache keys upstream (and logs
    // stop showing a naked trailing `?` on the default dashboard request).
    const query = qs.toString();
    const url = query ? `/api/recordings?${query}` : "/api/recordings";
    return jsonFetch<RecordingsListResponse>(url);
  },
  recordingDetail: (id: string) =>
    jsonFetch<RecordingDetailResponse>(`/api/recordings/${id}`),
  deleteRecording: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}`, { method: "DELETE" }),
  syncStatus: () => jsonFetch<SyncStatusResponse>("/api/sync/status"),
  syncTrigger: () =>
    jsonFetch<{ ok: boolean }>("/api/sync/trigger", { method: "POST", body: "{}" }),
  // Inbox mutations — each returns the freshly-hydrated RecordingDetail so the
  // React Query cache can be patched without a second round-trip. The response
  // also carries fresh `availableTags` / `availableCategories` so the
  // detail-page autocomplete reflects a newly-added value immediately.
  // `notes` is only valid when status is "reviewed" (enforced both by the
  // shared `InboxStatusPatchRequest` discriminated union and by the server).
  // The conditional tuple on `...args` makes the constraint compile-time:
  // `setInboxStatus(id, "new")` is valid, `setInboxStatus(id, "new", "x")` is
  // a type error, and `setInboxStatus(id, "reviewed", "x")` passes.
  setInboxStatus: <TStatus extends InboxStatus>(
    id: string,
    status: TStatus,
    ...args: TStatus extends "reviewed" ? [notes?: string] : []
  ) => {
    const notes = args[0];
    return jsonFetch<InboxMutationResponse>(`/api/recordings/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, ...(notes !== undefined ? { notes } : {}) }),
    });
  },
  setSnooze: (id: string, snoozedUntil: number | null) =>
    jsonFetch<InboxMutationResponse>(`/api/recordings/${id}/snooze`, {
      method: "PATCH",
      body: JSON.stringify({ snoozedUntil }),
    }),
  setCategory: (id: string, category: string | null) =>
    jsonFetch<InboxMutationResponse>(`/api/recordings/${id}/category`, {
      method: "PATCH",
      body: JSON.stringify({ category }),
    }),
  setInboxNotes: (id: string, notes: string | null) =>
    jsonFetch<InboxMutationResponse>(`/api/recordings/${id}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    }),
  addTag: (id: string, tag: string) =>
    jsonFetch<InboxMutationResponse>(`/api/recordings/${id}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag }),
    }),
  removeTag: (id: string, tag: string) =>
    jsonFetch<InboxMutationResponse>(
      `/api/recordings/${id}/tags/${encodeURIComponent(tag)}`,
      { method: "DELETE" },
    ),
  addJiraLink: (id: string, params: { issueKey: string; issueUrl?: string | null; relation?: string }) =>
    jsonFetch<InboxMutationResponse>(`/api/recordings/${id}/jira-links`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
  removeJiraLink: (id: string, issueKey: string) =>
    jsonFetch<InboxMutationResponse>(
      `/api/recordings/${id}/jira-links/${encodeURIComponent(issueKey)}`,
      { method: "DELETE" },
    ),
};
