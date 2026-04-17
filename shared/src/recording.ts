export interface PlaudRawRecording {
  id: string;
  filename: string;
  fullname: string;
  filesize: number;
  file_md5: string;
  start_time: number;
  end_time: number;
  duration: number;
  version: number;
  version_ms: number;
  edit_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  serial_number: string;
  filetype?: string;
  timezone?: number;
  zonemins?: number;
  scene?: number;
  filetag_id_list?: string[];
  is_markmemo?: boolean;
  wait_pull?: number;
}

export interface PlaudListResponse {
  status: number;
  msg: string;
  request_id?: string;
  data_file_total: number;
  data_file_list: PlaudRawRecording[];
}

export type RecordingStatus =
  | "pending_audio"
  | "audio_only"
  | "pending_transcript"
  | "complete"
  | "error"
  | "historical";

export type InboxStatus = "new" | "reviewed" | "archived";

// "snoozed" is virtual: persisted inbox_status='new' with snoozed_until > now.
// Server computes it and exposes it alongside the raw inboxStatus so the client
// does not have to recompute (and drift from) the same clock.
export type EffectiveInboxStatus = InboxStatus | "snoozed";

export interface JiraLink {
  id: number;
  issueKey: string;
  issueUrl: string | null;
  relation: string;
  createdAt: number;
}

export interface RecordingRow {
  id: string;
  filename: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  filesizeBytes: number;
  serialNumber: string;
  folder: string;
  audioPath: string | null;
  transcriptPath: string | null;
  summaryPath: string | null;
  metadataPath: string | null;
  audioDownloadedAt: number | null;
  transcriptDownloadedAt: number | null;
  webhookAudioFiredAt: number | null;
  webhookTranscriptFiredAt: number | null;
  isTrash: boolean;
  isHistorical: boolean;
  lastError: string | null;
  status: RecordingStatus;
  inboxStatus: InboxStatus;
  effectiveInboxStatus: EffectiveInboxStatus;
  category: string | null;
  snoozedUntil: number | null;
  reviewedAt: number | null;
  tags: string[];
}

export interface RecordingDetail extends RecordingRow {
  transcriptText: string | null;
  summaryMarkdown: string | null;
  metadata: Record<string, unknown> | null;
  inboxNotes: string | null;
  jiraLinks: JiraLink[];
}

export type SyncEventType =
  | "poll_start"
  | "poll_end"
  | "recording_new"
  | "recording_downloaded"
  | "recording_renamed"
  | "error"
  | "auth_required";

export interface SyncEvent {
  type: SyncEventType;
  at: number;
  recordingId?: string;
  message?: string;
}

export type WebhookEvent = "audio_ready" | "transcript_ready";

export interface WebhookPayload {
  event: WebhookEvent;
  recording: {
    id: string;
    filename: string;
    start_time_ms: number;
    end_time_ms: number;
    duration_ms: number;
    filesize_bytes: number;
    serial_number: string;
  };
  files: {
    folder: string;
    audio: string;
    transcript: string;
    summary: string;
  };
  http_urls: {
    audio: string;
    transcript: string;
    summary: string;
  };
  /**
   * On `transcript_ready` events we include the flattened transcript text and
   * summary markdown inline so webhook consumers (e.g. n8n) can build workflows
   * without a second fetch. Omitted on `audio_ready`. Raw transcript.json with
   * speaker embeddings is NOT inlined because of size; fetch it from
   * `http_urls.transcript` when needed.
   */
  content?: {
    transcript_text: string | null;
    summary_markdown: string | null;
  };
}
