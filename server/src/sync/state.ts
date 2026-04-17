import { renameSync, existsSync } from "node:fs";
import path from "node:path";
import type {
  RecordingRow,
  PlaudRawRecording,
  RecordingsListFilter,
  InboxStatus,
  JiraLink,
} from "@applaud/shared";
import {
  getDb,
  rowToRecording,
  loadTagsForRecordings,
  loadTagsForRecording,
  loadJiraLinksForRecording,
  loadAllTags,
  loadAllCategories,
  type RecordingDbRow,
} from "../db.js";
import { folderName, recordingPaths } from "./layout.js";
import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { emit } from "./events.js";

export interface UpsertOptions {
  isHistorical?: boolean;
}

export function upsertFromPlaud(item: PlaudRawRecording, opts: UpsertOptions = {}): RecordingRow {
  const db = getDb();
  const existing = db
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(item.id);
  if (existing) {
    if (existing.filename !== item.filename) {
      renameRecordingFolder(existing, item.filename);
    }
    const trashVal = item.is_trash ? 1 : 0;
    if (existing.is_trash !== trashVal) {
      db.prepare("UPDATE recordings SET is_trash = ? WHERE id = ?").run(trashVal, item.id);
    }
    return rowToRecording(
      db.prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?").get(item.id)!,
    );
  }

  const cfg = loadConfig();
  if (!cfg.recordingsDir) throw new Error("recordingsDir not configured");
  const folder = folderName(item.start_time, item.filename, item.id);
  const paths = recordingPaths(cfg.recordingsDir, folder);

  db.prepare(
    `INSERT INTO recordings (
      id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number,
      folder, audio_path, transcript_path, summary_path, metadata_path,
      audio_downloaded_at, transcript_downloaded_at, webhook_audio_fired_at,
      webhook_transcript_fired_at, is_trash, is_historical, last_error, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(
    item.id,
    item.filename,
    item.start_time,
    item.end_time,
    item.duration,
    item.filesize,
    item.serial_number,
    folder,
    paths.audioPath,
    paths.transcriptJsonPath,
    paths.summaryMdPath,
    paths.metadataPath,
    item.is_trash ? 1 : 0,
    opts.isHistorical ? 1 : 0,
  );

  return rowToRecording(
    db
      .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
      .get(item.id)!,
  );
}

function renameRecordingFolder(row: RecordingDbRow, newFilename: string): void {
  const cfg = loadConfig();
  if (!cfg.recordingsDir) return;

  const newFolder = folderName(row.start_time, newFilename, row.id);
  if (newFolder === row.folder) {
    getDb().prepare("UPDATE recordings SET filename = ? WHERE id = ?").run(newFilename, row.id);
    emit("recording_renamed", { recordingId: row.id });
    return;
  }

  const oldAbs = path.join(cfg.recordingsDir, row.folder);
  const newAbs = path.join(cfg.recordingsDir, newFolder);

  if (existsSync(oldAbs)) {
    renameSync(oldAbs, newAbs);
    logger.info({ id: row.id, oldFolder: row.folder, newFolder }, "renamed recording folder");
  }

  const newPaths = recordingPaths(cfg.recordingsDir, newFolder);
  getDb()
    .prepare(
      `UPDATE recordings
         SET filename = ?, folder = ?, audio_path = ?, transcript_path = ?, summary_path = ?, metadata_path = ?
       WHERE id = ?`,
    )
    .run(
      newFilename,
      newFolder,
      newPaths.audioPath,
      newPaths.transcriptJsonPath,
      newPaths.summaryMdPath,
      newPaths.metadataPath,
      row.id,
    );
  emit("recording_renamed", { recordingId: row.id });
}

export function markAudioDownloaded(id: string, sizeBytes: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET audio_downloaded_at = ?, filesize_bytes = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, sizeBytes, id);
}

export function markTranscriptDownloaded(id: string, transcriptText?: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE recordings SET transcript_downloaded_at = ?, transcript_text = ?, last_error = NULL WHERE id = ?",
    )
    .run(now, transcriptText ?? null, id);
}

export function markWebhookFired(id: string, event: "audio_ready" | "transcript_ready"): void {
  const col = event === "audio_ready" ? "webhook_audio_fired_at" : "webhook_transcript_fired_at";
  getDb().prepare(`UPDATE recordings SET ${col} = ? WHERE id = ?`).run(Date.now(), id);
}

export function recordError(id: string, message: string): void {
  getDb()
    .prepare("UPDATE recordings SET last_error = ? WHERE id = ?")
    .run(message.slice(0, 500), id);
}

export function clearError(id: string): void {
  getDb().prepare("UPDATE recordings SET last_error = NULL WHERE id = ?").run(id);
}

export interface ListRecordingsOptions {
  limit?: number;
  offset?: number;
  search?: string;
  filter?: RecordingsListFilter;
  tag?: string;
  category?: string;
}

// Build the WHERE clause for the filter axis. Returns a SQL fragment plus the
// ordered list of bind parameters. Centralized so COUNT(*) and the paged SELECT
// stay in lockstep — filter drift between them would return wrong totals.
function filterClause(
  filter: RecordingsListFilter | undefined,
  now: number,
): { sql: string; params: unknown[] } {
  switch (filter) {
    case "active":
    case "new":
      // "active" and "new" both mean inbox_status='new' AND not currently snoozed.
      // Matches inbox-mcp listNew() semantics.
      return {
        sql: "inbox_status = 'new' AND (snoozed_until IS NULL OR snoozed_until <= ?)",
        params: [now],
      };
    case "snoozed":
      return {
        sql: "inbox_status = 'new' AND snoozed_until IS NOT NULL AND snoozed_until > ?",
        params: [now],
      };
    case "reviewed":
      return { sql: "inbox_status = 'reviewed'", params: [] };
    case "archived":
      return { sql: "inbox_status = 'archived'", params: [] };
    case "all":
    case undefined:
      return { sql: "1=1", params: [] };
  }
}

export function listRecordingRows(opts: ListRecordingsOptions = {}): {
  total: number;
  totalBytes: number;
  items: RecordingRow[];
  availableTags: string[];
  availableCategories: string[];
} {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const search = opts.search?.trim();
  const now = Date.now();
  const { sql: filterSql, params: filterParams } = filterClause(opts.filter, now);

  const conditions: string[] = [filterSql];
  const params: unknown[] = [...filterParams];

  if (search) {
    const like = `%${search}%`;
    conditions.push("(filename LIKE ? OR transcript_text LIKE ?)");
    params.push(like, like);
  }
  if (opts.category) {
    conditions.push("category = ?");
    params.push(opts.category);
  }
  if (opts.tag) {
    conditions.push(
      "EXISTS (SELECT 1 FROM recording_tags t WHERE t.recording_id = recordings.id AND t.tag = ?)",
    );
    params.push(opts.tag);
  }

  const where = conditions.join(" AND ");

  const aggRow = db
    .prepare<unknown[], { c: number; b: number }>(
      `SELECT COUNT(*) AS c, COALESCE(SUM(filesize_bytes), 0) AS b FROM recordings WHERE ${where}`,
    )
    .get(...params) as { c: number; b: number } | undefined;

  const rows = db
    .prepare<unknown[], RecordingDbRow>(
      `SELECT * FROM recordings WHERE ${where} ORDER BY start_time DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const tagMap = loadTagsForRecordings(rows.map((r) => r.id));

  return {
    total: aggRow?.c ?? 0,
    totalBytes: aggRow?.b ?? 0,
    // Thread the same `now` we used for the snooze-aware filter clause so the
    // per-row `effectiveInboxStatus` can't flip to/from "snoozed" between
    // filter evaluation and row hydration.
    items: rows.map((r) => rowToRecording(r, tagMap.get(r.id) ?? [], now)),
    availableTags: loadAllTags(),
    availableCategories: loadAllCategories(),
  };
}

export function getRecordingById(id: string): RecordingRow | null {
  const row = getDb()
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(id);
  if (!row) return null;
  return rowToRecording(row, loadTagsForRecording(id));
}

export interface RecordingWithRelations {
  row: RecordingRow;
  inboxNotes: string | null;
  jiraLinks: JiraLink[];
}

export function getRecordingWithRelations(id: string): RecordingWithRelations | null {
  const raw = getDb()
    .prepare<[string], RecordingDbRow>("SELECT * FROM recordings WHERE id = ?")
    .get(id);
  if (!raw) return null;
  return {
    row: rowToRecording(raw, loadTagsForRecording(id)),
    inboxNotes: raw.inbox_notes,
    jiraLinks: loadJiraLinksForRecording(id),
  };
}

// --- Inbox mutations. Each returns `true` when a row actually changed so the
// route layer can distinguish "unknown recording" from "no-op update". These
// mirror the inbox-mcp surface one-to-one so both writers agree on semantics. ---

export function setInboxStatus(
  id: string,
  status: InboxStatus,
  notes: string | null,
): boolean {
  const db = getDb();
  const now = Date.now();
  if (status === "reviewed") {
    return (
      db
        .prepare(
          "UPDATE recordings SET inbox_status = 'reviewed', reviewed_at = ?, inbox_notes = COALESCE(?, inbox_notes) WHERE id = ?",
        )
        .run(now, notes, id).changes > 0
    );
  }
  if (status === "archived") {
    return db.prepare("UPDATE recordings SET inbox_status = 'archived' WHERE id = ?").run(id).changes > 0;
  }
  // Resetting to 'new' also clears reviewed_at and snoozed_until: after a
  // manual reopen the user expects the item to behave like an active inbox
  // item, not to silently re-snooze on a stale timestamp from before it was
  // reviewed/archived. The MCP's unnotifiedNew() also sees it again.
  return (
    db
      .prepare(
        "UPDATE recordings SET inbox_status = 'new', reviewed_at = NULL, snoozed_until = NULL WHERE id = ?",
      )
      .run(id).changes > 0
  );
}

export function setSnoozedUntil(id: string, until: number | null): boolean {
  const db = getDb();
  if (until === null) {
    return db.prepare("UPDATE recordings SET snoozed_until = NULL WHERE id = ?").run(id).changes > 0;
  }
  // Match inbox-mcp's snooze(): only 'new' rows can be snoozed. Reviewed or
  // archived items must be reopened first — consistent with the MCP contract.
  return (
    db
      .prepare("UPDATE recordings SET snoozed_until = ? WHERE id = ? AND inbox_status = 'new'")
      .run(until, id).changes > 0
  );
}

export function setCategory(id: string, category: string | null): boolean {
  const db = getDb();
  const trimmed = category?.trim() || null;
  return db.prepare("UPDATE recordings SET category = ? WHERE id = ?").run(trimmed, id).changes > 0;
}

export function setInboxNotes(id: string, notes: string | null): boolean {
  const db = getDb();
  return db.prepare("UPDATE recordings SET inbox_notes = ? WHERE id = ?").run(notes, id).changes > 0;
}

export function addRecordingTag(id: string, tag: string): boolean {
  const trimmed = tag.trim();
  if (!trimmed) return false;
  const db = getDb();
  return (
    db
      .prepare("INSERT OR IGNORE INTO recording_tags (recording_id, tag) VALUES (?, ?)")
      .run(id, trimmed).changes > 0
  );
}

export function removeRecordingTag(id: string, tag: string): boolean {
  const db = getDb();
  return (
    db
      .prepare("DELETE FROM recording_tags WHERE recording_id = ? AND tag = ?")
      .run(id, tag).changes > 0
  );
}

export function addJiraLink(params: {
  recordingId: string;
  issueKey: string;
  issueUrl: string | null;
  relation: string;
}): boolean {
  const db = getDb();
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO recording_jira_links (recording_id, issue_key, issue_url, relation, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        params.recordingId,
        params.issueKey,
        params.issueUrl,
        params.relation,
        Date.now(),
      ).changes > 0
  );
}

export function removeJiraLink(recordingId: string, issueKey: string): boolean {
  const db = getDb();
  return (
    db
      .prepare("DELETE FROM recording_jira_links WHERE recording_id = ? AND issue_key = ?")
      .run(recordingId, issueKey).changes > 0
  );
}

export function deleteRecording(id: string): void {
  getDb().prepare("DELETE FROM recordings WHERE id = ?").run(id);
}

export function countPendingTranscripts(): number {
  const row = getDb()
    .prepare<[], { c: number }>(
      "SELECT COUNT(*) AS c FROM recordings WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NULL",
    )
    .get();
  return row?.c ?? 0;
}

export function countErrorsLast24h(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const row = getDb()
    .prepare<[number, number], { c: number }>(
      "SELECT COUNT(*) AS c FROM recordings WHERE last_error IS NOT NULL AND (audio_downloaded_at > ? OR transcript_downloaded_at > ?)",
    )
    .get(cutoff, cutoff);
  return row?.c ?? 0;
}

export function findPendingTranscriptIds(): string[] {
  const rows = getDb()
    .prepare<[], { id: string }>(
      "SELECT id FROM recordings WHERE audio_downloaded_at IS NOT NULL AND transcript_downloaded_at IS NULL AND is_historical = 0",
    )
    .all();
  return rows.map((r) => r.id);
}
