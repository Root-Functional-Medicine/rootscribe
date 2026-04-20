import { Factory } from "fishery";
import type {
  EffectiveInboxStatus,
  JiraLink,
  RecordingDetail,
} from "../recording.js";

// Fishery factory for RecordingDetail. Lives in @rootscribe/shared so the web
// client and server tests both consume the same canonical shape — drift between
// a web-side fixture and a server-side fixture would only be caught at runtime.
//
// Chainable traits return a new factory (via Fishery's `this.params(...)`) so
// callers can compose them: `recordingDetailFactory.reviewed().withTags("a").build()`.
// Status traits drive the inbox-status derivation (effectiveInboxStatus,
// snoozedUntil, reviewedAt) consistently — `snoozed` encodes the server-side
// invariant that inboxStatus stays "new" while effective flips to "snoozed".

class RecordingDetailFactory extends Factory<RecordingDetail> {
  reviewed(reviewedAt: number = Date.parse("2026-04-15T12:00:00Z")): this {
    return this.params({
      inboxStatus: "reviewed",
      effectiveInboxStatus: "reviewed",
      reviewedAt,
      snoozedUntil: null,
    }) as this;
  }

  archived(): this {
    return this.params({
      inboxStatus: "archived",
      effectiveInboxStatus: "archived",
      reviewedAt: null,
      snoozedUntil: null,
    }) as this;
  }

  snoozed(
    snoozedUntil: number = Date.parse("2026-04-20T00:00:00Z") + 86_400_000,
  ): this {
    return this.params({
      inboxStatus: "new",
      effectiveInboxStatus: "snoozed",
      snoozedUntil,
      reviewedAt: null,
    }) as this;
  }

  // Dispatch on an EffectiveInboxStatus, mirroring the InboxActions.test.tsx
  // `makeRecording(status)` helper. Keeps the test callsite as short as
  // `recordingDetailFactory.withStatus("archived").build()` when the status is
  // the only varying axis.
  withStatus(effective: EffectiveInboxStatus): this {
    if (effective === "reviewed") return this.reviewed();
    if (effective === "snoozed") return this.snoozed();
    if (effective === "archived") return this.archived();
    return this.params({
      inboxStatus: "new",
      effectiveInboxStatus: "new",
      snoozedUntil: null,
      reviewedAt: null,
    }) as this;
  }

  withJiraLinks(...jiraLinks: JiraLink[]): this {
    return this.params({ jiraLinks }) as this;
  }

  withTags(...tags: string[]): this {
    return this.params({ tags }) as this;
  }

  withCategory(category: string): this {
    return this.params({ category }) as this;
  }

  withTranscript(
    transcriptText: string = "the quick brown fox",
    transcriptDownloadedAt: number = Date.parse("2026-04-15T12:30:00Z"),
  ): this {
    return this.params({
      transcriptText,
      transcriptDownloadedAt,
    }) as this;
  }

  withSummary(
    summaryMarkdown: string = "## Summary\n\n- point one\n- point two",
  ): this {
    return this.params({ summaryMarkdown }) as this;
  }

  // `pending_audio` = row exists with paths computed but audio file hasn't
  // finished downloading. The server's `upsertFromPlaud` populates all four
  // *_Path columns at INSERT time from `recordingPaths(cfg.recordingsDir,
  // folder)`; `pending_audio` is derived purely from `audio_downloaded_at IS
  // NULL` (see server/src/db.ts::deriveStatus). Mirror that here so tests
  // that model real API payloads don't trip on a null path when production
  // code assumes the path exists.
  pendingAudio(): this {
    return this.params({
      status: "pending_audio",
      audioDownloadedAt: null,
      audioPath: "audio.ogg",
      transcriptPath: "transcript.json",
      summaryPath: "summary.md",
      metadataPath: "metadata.json",
    }) as this;
  }

  withError(lastError: string = "upstream 500"): this {
    return this.params({
      status: "error",
      lastError,
    }) as this;
  }

  withNotes(inboxNotes: string): this {
    return this.params({ inboxNotes }) as this;
  }
}

export const recordingDetailFactory = RecordingDetailFactory.define(() => ({
  id: "rec-1",
  filename: "f.ogg",
  startTime: 0,
  endTime: 0,
  durationMs: 0,
  filesizeBytes: 0,
  serialNumber: "",
  folder: "",
  audioPath: null,
  transcriptPath: null,
  summaryPath: null,
  metadataPath: null,
  audioDownloadedAt: null,
  transcriptDownloadedAt: null,
  webhookAudioFiredAt: null,
  webhookTranscriptFiredAt: null,
  isTrash: false,
  isHistorical: false,
  lastError: null,
  status: "complete" as const,
  inboxStatus: "new" as const,
  effectiveInboxStatus: "new" as const,
  category: null,
  snoozedUntil: null,
  reviewedAt: null,
  tags: [],
  transcriptText: null,
  summaryMarkdown: null,
  metadata: null,
  inboxNotes: null,
  jiraLinks: [],
}));
