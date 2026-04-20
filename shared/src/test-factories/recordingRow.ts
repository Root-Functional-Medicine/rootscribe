import { Factory } from "fishery";
import type { EffectiveInboxStatus, RecordingRow } from "../recording.js";

// Factory for RecordingRow — the DB-row projection of a recording. Server
// tests (poller, webhook post) that INSERT into the `recordings` SQLite table
// pass these values through better-sqlite3 prepared statements, which reject
// extraneous columns. RecordingDetail adds `transcriptText`, `summaryMarkdown`,
// `metadata`, `inboxNotes`, and `jiraLinks` on top of RecordingRow — if those
// fields flow into an INSERT, better-sqlite3 throws. Use the row factory on
// server-side DB paths and the detail factory in UI/detail-page paths.

class RecordingRowFactory extends Factory<RecordingRow> {
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

  // Audio has landed but transcript hasn't — the mid-sync state where the
  // webhook_audio_fired_at has been set but webhook_transcript_fired_at still
  // null. Common shape for poller tests covering downstream transcript fetch.
  audioOnly(
    audioDownloadedAt: number = Date.parse("2026-04-15T12:00:00Z"),
  ): this {
    return this.params({
      status: "audio_only",
      audioDownloadedAt,
      audioPath: "audio.ogg",
    }) as this;
  }

  // `pending_audio` = row exists with paths computed but audio file hasn't
  // finished downloading. The server's `upsertFromPlaud` populates all four
  // *_Path columns at INSERT time from `recordingPaths(cfg.recordingsDir,
  // folder)`; `pending_audio` is derived purely from `audio_downloaded_at IS
  // NULL` (see server/src/db.ts::deriveStatus). Mirror that here so tests
  // that model real server rows don't trip on a null path when production
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

  withTags(...tags: string[]): this {
    return this.params({ tags }) as this;
  }

  withCategory(category: string): this {
    return this.params({ category }) as this;
  }

  withFolder(folder: string): this {
    return this.params({ folder }) as this;
  }
}

export const recordingRowFactory = RecordingRowFactory.define(() => ({
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
}));
