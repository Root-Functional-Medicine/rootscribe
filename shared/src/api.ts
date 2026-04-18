import type { AppConfig } from "./config.js";
import type {
  RecordingRow,
  RecordingDetail,
  InboxStatus,
  EffectiveInboxStatus,
} from "./recording.js";

export interface AuthDetectResponse {
  found: boolean;
  token?: string;
  profile?: string;
  browser?: string;
  email?: string;
  error?: string;
}

export interface AuthWatchStartResponse {
  watchId: string;
}

export type AuthWatchEvent =
  | { type: "waiting"; elapsedMs: number }
  | { type: "found"; token: string; profile: string; browser: string; email?: string }
  | { type: "timeout" }
  | { type: "error"; message: string };

export interface AuthManualRequest {
  token: string;
}

export interface AuthValidateResponse {
  ok: boolean;
  email?: string;
  exp?: number;
  error?: string;
}

export interface SetupStatusResponse {
  setupComplete: boolean;
  hasToken: boolean;
  hasRecordingsDir: boolean;
}

// Filter axis for the list endpoint. "active" mirrors the inbox-mcp list_new
// semantics (inbox_status='new' and not currently snoozed). "all" is the default
// dashboard view that shows every recording regardless of state.
export type RecordingsListFilter = "all" | EffectiveInboxStatus | "active";

export interface RecordingsListQuery {
  limit?: number;
  offset?: number;
  search?: string;
  from?: number;
  to?: number;
  filter?: RecordingsListFilter;
  tag?: string;
  category?: string;
}

export interface RecordingsListResponse {
  total: number;
  totalBytes: number;
  items: RecordingRow[];
  availableTags: string[];
  availableCategories: string[];
}

export interface RecordingDetailResponse {
  recording: RecordingDetail;
  mediaBase: string;
  recordingsDir?: string;
  // Autocomplete facets for the detail-page editors. Surfaced here (instead of
  // requiring a second call to the list endpoint with `?facets=1`) so the tag
  // and category editors can suggest existing values as the user types.
  availableTags: string[];
  availableCategories: string[];
}

// Inbox mutation payloads. Kept in shared so the web client and server use the
// same contract at compile time — drift here would only be caught at runtime.
//
// `notes` is only valid for the `reviewed` transition (the route rejects it
// on other statuses since `setInboxStatus` only merges notes into
// inbox_notes during the reviewed branch). Discriminated union encodes that
// at the type level so clients can't pass notes with `new`/`archived`.
export type InboxStatusPatchRequest =
  | {
      status: "reviewed";
      // Optional merge-only notes. Clients clear notes via
      // InboxNotesPatchRequest (which accepts explicit null) — keeping the
      // "clear" semantics on a single endpoint means /status rejects null.
      notes?: string;
    }
  | {
      status: Exclude<InboxStatus, "reviewed">;
      notes?: never;
    };

export interface InboxSnoozePatchRequest {
  // Epoch ms. Null clears the snooze (equivalent to unsnooze).
  snoozedUntil: number | null;
}

export interface InboxCategoryPatchRequest {
  category: string | null;
}

export interface InboxNotesPatchRequest {
  notes: string | null;
}

export interface InboxTagRequest {
  tag: string;
}

export interface InboxJiraLinkRequest {
  issueKey: string;
  issueUrl?: string | null;
  relation?: string;
}

export interface InboxMutationResponse {
  recording: RecordingDetail;
  // Refreshed autocomplete facets so a newly-added tag or category appears in
  // suggestions without a follow-up fetch. Present on every mutation response
  // because add/remove/setCategory can each change the DISTINCT sets.
  availableTags: string[];
  availableCategories: string[];
}

export interface SyncStatusResponse {
  lastPollAt: number | null;
  nextPollAt: number | null;
  polling: boolean;
  pendingTranscripts: number;
  errorsLast24h: number;
  lastError: string | null;
  authRequired: boolean;
}

export interface ConfigResponse {
  config: AppConfig;
}

export interface WebhookTestRequest {
  url: string;
}

export interface WebhookTestResponse {
  ok: boolean;
  statusCode?: number;
  bodySnippet?: string;
  error?: string;
  durationMs: number;
}

export interface RecordingsDirValidateRequest {
  path: string;
}

export interface RecordingsDirValidateResponse {
  ok: boolean;
  absolutePath?: string;
  exists?: boolean;
  writable?: boolean;
  freeBytes?: number;
  error?: string;
}
