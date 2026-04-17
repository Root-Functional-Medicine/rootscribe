import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { dbPath } from "./paths.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(dbPath(), { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Shared DB with the server process — wait up to 5s on contention instead
  // of failing immediately with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  return db;
}

export type InboxStatus = "new" | "reviewed" | "archived" | "snoozed";

export interface InboxRow {
  id: string;
  filename: string;
  folder: string;
  start_time: number;
  duration_ms: number;
  transcript_path: string | null;
  summary_path: string | null;
  inbox_status: InboxStatus;
  inbox_notes: string | null;
  category: string | null;
  reviewed_at: number | null;
  snoozed_until: number | null;
  channel_notified_at: number | null;
  transcript_downloaded_at: number | null;
}

export interface JiraLinkRow {
  id: number;
  recording_id: string;
  issue_key: string;
  issue_url: string | null;
  relation: string;
  created_at: number;
}

const INBOX_COLS = `
  id, filename, folder, start_time, duration_ms,
  transcript_path, summary_path,
  inbox_status, inbox_notes, category, reviewed_at, snoozed_until,
  channel_notified_at, transcript_downloaded_at
`;

export function listNew(params: { limit?: number; category?: string; tag?: string }): InboxRow[] {
  const d = getDb();
  const limit = Math.min(params.limit ?? 25, 200);
  const now = Date.now();

  if (params.tag) {
    return d
      .prepare(
        `SELECT ${INBOX_COLS} FROM recordings r
         WHERE r.inbox_status = 'new'
           AND r.transcript_downloaded_at IS NOT NULL
           AND (r.snoozed_until IS NULL OR r.snoozed_until < ?)
           AND (? IS NULL OR r.category = ?)
           AND EXISTS (SELECT 1 FROM recording_tags t WHERE t.recording_id = r.id AND t.tag = ?)
         ORDER BY r.start_time DESC
         LIMIT ?`,
      )
      .all(now, params.category ?? null, params.category ?? null, params.tag, limit) as InboxRow[];
  }

  return d
    .prepare(
      `SELECT ${INBOX_COLS} FROM recordings
       WHERE inbox_status = 'new'
         AND transcript_downloaded_at IS NOT NULL
         AND (snoozed_until IS NULL OR snoozed_until < ?)
         AND (? IS NULL OR category = ?)
       ORDER BY start_time DESC
       LIMIT ?`,
    )
    .all(now, params.category ?? null, params.category ?? null, limit) as InboxRow[];
}

export function recent(params: { limit?: number; status?: InboxStatus }): InboxRow[] {
  const d = getDb();
  const limit = Math.min(params.limit ?? 25, 200);
  if (params.status) {
    return d
      .prepare(
        `SELECT ${INBOX_COLS} FROM recordings WHERE inbox_status = ? ORDER BY start_time DESC LIMIT ?`,
      )
      .all(params.status, limit) as InboxRow[];
  }
  return d
    .prepare(`SELECT ${INBOX_COLS} FROM recordings ORDER BY start_time DESC LIMIT ?`)
    .all(limit) as InboxRow[];
}

export function getRecording(recordingId: string): InboxRow | null {
  const d = getDb();
  return (d
    .prepare(`SELECT ${INBOX_COLS} FROM recordings WHERE id = ?`)
    .get(recordingId) as InboxRow | undefined) ?? null;
}

export function readTranscriptText(row: InboxRow): string | null {
  if (!row.transcript_path) return null;
  // transcript_path in DB points to the JSON; the human-readable .txt lives next to it
  const txtPath = path.join(path.dirname(row.transcript_path), "transcript.txt");
  if (!existsSync(txtPath)) return null;
  try {
    return readFileSync(txtPath, "utf8");
  } catch {
    return null;
  }
}

export function readSummaryMarkdown(row: InboxRow): string | null {
  if (!row.summary_path) return null;
  if (!existsSync(row.summary_path)) return null;
  try {
    return readFileSync(row.summary_path, "utf8");
  } catch {
    return null;
  }
}

export function search(query: string, limit = 25): InboxRow[] {
  const d = getDb();
  // Escape backslash first, then LIKE wildcards, so ESCAPE '\' behaves literally
  // for every input (including queries that contain a literal backslash).
  const like = `%${query.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&")}%`;
  return d
    .prepare(
      `SELECT ${INBOX_COLS} FROM recordings
       WHERE (filename LIKE ? ESCAPE '\\' OR transcript_text LIKE ? ESCAPE '\\')
       ORDER BY start_time DESC
       LIMIT ?`,
    )
    .all(like, like, Math.min(limit, 200)) as InboxRow[];
}

export function markReviewed(recordingId: string, notes: string | null): boolean {
  const d = getDb();
  const res = d
    .prepare(
      `UPDATE recordings SET inbox_status = 'reviewed', reviewed_at = ?, inbox_notes = COALESCE(?, inbox_notes) WHERE id = ?`,
    )
    .run(Date.now(), notes, recordingId);
  return res.changes > 0;
}

export function archive(recordingId: string): boolean {
  const d = getDb();
  return d.prepare("UPDATE recordings SET inbox_status = 'archived' WHERE id = ?").run(recordingId).changes > 0;
}

export function snooze(recordingId: string, until: number): boolean {
  const d = getDb();
  return d
    .prepare("UPDATE recordings SET inbox_status = 'snoozed', snoozed_until = ? WHERE id = ?")
    .run(until, recordingId).changes > 0;
}

export function unsnooze(recordingId: string): boolean {
  const d = getDb();
  return d
    .prepare("UPDATE recordings SET inbox_status = 'new', snoozed_until = NULL WHERE id = ?")
    .run(recordingId).changes > 0;
}

export function categorize(recordingId: string, category: string | null): boolean {
  const d = getDb();
  return d.prepare("UPDATE recordings SET category = ? WHERE id = ?").run(category, recordingId).changes > 0;
}

export function addTags(recordingId: string, tags: string[]): number {
  const d = getDb();
  const stmt = d.prepare(
    "INSERT OR IGNORE INTO recording_tags (recording_id, tag) VALUES (?, ?)",
  );
  let inserted = 0;
  const txn = d.transaction((items: string[]) => {
    for (const tag of items) {
      const r = stmt.run(recordingId, tag);
      inserted += r.changes;
    }
  });
  txn(tags);
  return inserted;
}

export function removeTags(recordingId: string, tags: string[]): number {
  const d = getDb();
  const stmt = d.prepare("DELETE FROM recording_tags WHERE recording_id = ? AND tag = ?");
  let removed = 0;
  const txn = d.transaction((items: string[]) => {
    for (const tag of items) removed += stmt.run(recordingId, tag).changes;
  });
  txn(tags);
  return removed;
}

export function getTags(recordingId: string): string[] {
  const d = getDb();
  return (d
    .prepare("SELECT tag FROM recording_tags WHERE recording_id = ? ORDER BY tag")
    .all(recordingId) as { tag: string }[]).map((r) => r.tag);
}

export function linkJira(params: {
  recordingId: string;
  issueKey: string;
  issueUrl: string | null;
  relation: string;
}): boolean {
  const d = getDb();
  const res = d
    .prepare(
      `INSERT OR IGNORE INTO recording_jira_links (recording_id, issue_key, issue_url, relation, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(params.recordingId, params.issueKey, params.issueUrl, params.relation, Date.now());
  return res.changes > 0;
}

export function unlinkJira(recordingId: string, issueKey: string): boolean {
  const d = getDb();
  return d
    .prepare("DELETE FROM recording_jira_links WHERE recording_id = ? AND issue_key = ?")
    .run(recordingId, issueKey).changes > 0;
}

export function getJiraLinks(recordingId: string): JiraLinkRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM recording_jira_links WHERE recording_id = ? ORDER BY created_at DESC")
    .all(recordingId) as JiraLinkRow[];
}

export function unnotifiedNew(): Pick<InboxRow, "id" | "filename" | "duration_ms">[] {
  const d = getDb();
  return d
    .prepare(
      `SELECT id, filename, duration_ms FROM recordings
       WHERE inbox_status = 'new'
         AND transcript_downloaded_at IS NOT NULL
         AND channel_notified_at IS NULL
       ORDER BY start_time DESC
       LIMIT 50`,
    )
    .all() as Pick<InboxRow, "id" | "filename" | "duration_ms">[];
}

export function markNotified(recordingId: string): void {
  const d = getDb();
  d.prepare("UPDATE recordings SET channel_notified_at = ? WHERE id = ?").run(Date.now(), recordingId);
}
