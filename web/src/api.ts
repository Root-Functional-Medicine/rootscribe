import type {
  AuthDetectResponse,
  AuthValidateResponse,
  ConfigResponse,
  RecordingsListResponse,
  RecordingDetail,
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
    const body = await res.text().catch(() => "");
    throw new ApiError(body || `HTTP ${res.status}`, res.status);
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
    return jsonFetch<RecordingsListResponse>(`/api/recordings?${qs.toString()}`);
  },
  recordingDetail: (id: string) =>
    jsonFetch<{ recording: RecordingDetail; mediaBase: string; recordingsDir?: string }>(
      `/api/recordings/${id}`,
    ),
  deleteRecording: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/recordings/${id}`, { method: "DELETE" }),
  syncStatus: () => jsonFetch<SyncStatusResponse>("/api/sync/status"),
  syncTrigger: () =>
    jsonFetch<{ ok: boolean }>("/api/sync/trigger", { method: "POST", body: "{}" }),
  // Inbox mutations — each returns the freshly-hydrated RecordingDetail so the
  // React Query cache can be patched without a second round-trip.
  setInboxStatus: (id: string, status: InboxStatus, notes?: string | null) =>
    jsonFetch<{ recording: RecordingDetail }>(`/api/recordings/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, ...(notes !== undefined ? { notes } : {}) }),
    }),
  setSnooze: (id: string, snoozedUntil: number | null) =>
    jsonFetch<{ recording: RecordingDetail }>(`/api/recordings/${id}/snooze`, {
      method: "PATCH",
      body: JSON.stringify({ snoozedUntil }),
    }),
  setCategory: (id: string, category: string | null) =>
    jsonFetch<{ recording: RecordingDetail }>(`/api/recordings/${id}/category`, {
      method: "PATCH",
      body: JSON.stringify({ category }),
    }),
  setInboxNotes: (id: string, notes: string | null) =>
    jsonFetch<{ recording: RecordingDetail }>(`/api/recordings/${id}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    }),
  addTag: (id: string, tag: string) =>
    jsonFetch<{ recording: RecordingDetail }>(`/api/recordings/${id}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag }),
    }),
  removeTag: (id: string, tag: string) =>
    jsonFetch<{ recording: RecordingDetail }>(
      `/api/recordings/${id}/tags/${encodeURIComponent(tag)}`,
      { method: "DELETE" },
    ),
  addJiraLink: (id: string, params: { issueKey: string; issueUrl?: string | null; relation?: string }) =>
    jsonFetch<{ recording: RecordingDetail }>(`/api/recordings/${id}/jira-links`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
  removeJiraLink: (id: string, issueKey: string) =>
    jsonFetch<{ recording: RecordingDetail }>(
      `/api/recordings/${id}/jira-links/${encodeURIComponent(issueKey)}`,
      { method: "DELETE" },
    ),
};
