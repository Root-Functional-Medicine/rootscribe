import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ensureConfigDir, dbPath } from "./paths.js";
import type {
  RecordingRow,
  RecordingStatus,
  InboxStatus,
  EffectiveInboxStatus,
  JiraLink,
} from "@applaud/shared";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureConfigDir();
  db = new Database(dbPath());
  // inbox-mcp also writes to this file (tags, jira links, inbox_notes, etc.).
  // Set busy_timeout first so every subsequent PRAGMA waits on contention
  // instead of failing immediately with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      filesize_bytes INTEGER NOT NULL,
      serial_number TEXT NOT NULL,
      folder TEXT NOT NULL,
      audio_path TEXT,
      transcript_path TEXT,
      summary_path TEXT,
      metadata_path TEXT,
      audio_downloaded_at INTEGER,
      transcript_downloaded_at INTEGER,
      webhook_audio_fired_at INTEGER,
      webhook_transcript_fired_at INTEGER,
      is_historical INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recordings_start_time ON recordings(start_time DESC);

    CREATE TABLE IF NOT EXISTS webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      response_snippet TEXT,
      fired_at INTEGER NOT NULL,
      duration_ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_log_fired_at ON webhook_log(fired_at DESC);
  `);

  // v2: add is_trash column
  try {
    d.exec("ALTER TABLE recordings ADD COLUMN is_trash INTEGER NOT NULL DEFAULT 0");
  } catch {
    // column already exists — ignore
  }

  // v3: add transcript_text column for full-text search
  try {
    d.exec("ALTER TABLE recordings ADD COLUMN transcript_text TEXT");
  } catch {
    // column already exists — ignore
  }

  // Backfill transcript_text from existing transcript.txt files on disk
  const pending = d
    .prepare("SELECT id, transcript_path FROM recordings WHERE transcript_downloaded_at IS NOT NULL AND transcript_text IS NULL")
    .all() as { id: string; transcript_path: string | null }[];
  if (pending.length > 0) {
    const update = d.prepare("UPDATE recordings SET transcript_text = ? WHERE id = ?");
    for (const row of pending) {
      if (!row.transcript_path) continue;
      const txtPath = path.join(path.dirname(row.transcript_path), "transcript.txt");
      try {
        if (existsSync(txtPath)) {
          update.run(readFileSync(txtPath, "utf8"), row.id);
        }
      } catch {
        /* best effort */
      }
    }
  }

  // v4 (rootscribe): inbox workflow + jira links + tags.
  // Uses prepare().run() per statement to keep each DDL discrete.
  const safeDdl = (sql: string): void => {
    try {
      d.prepare(sql).run();
    } catch (err: unknown) {
      if (err instanceof Database.SqliteError) {
        const message = err.message.toLowerCase();
        if (message.includes("duplicate column name") || message.includes("already exists")) {
          return;
        }
      }
      throw err;
    }
  };

  // Wrap the whole v4 DDL block in a single transaction so the inbox-mcp
  // never sees a partial v4 schema on a crashed/killed server. safeDdl still
  // tolerates "duplicate column" / "already exists" for re-run idempotency.
  d.transaction(() => {
    safeDdl("ALTER TABLE recordings ADD COLUMN inbox_status TEXT NOT NULL DEFAULT 'new'");
    safeDdl("ALTER TABLE recordings ADD COLUMN inbox_notes TEXT");
    safeDdl("ALTER TABLE recordings ADD COLUMN reviewed_at INTEGER");
    safeDdl("ALTER TABLE recordings ADD COLUMN category TEXT");
    safeDdl("ALTER TABLE recordings ADD COLUMN snoozed_until INTEGER");
    safeDdl("ALTER TABLE recordings ADD COLUMN channel_notified_at INTEGER");

    d.prepare("CREATE INDEX IF NOT EXISTS idx_recordings_inbox_status ON recordings(inbox_status, start_time DESC)").run();
    // Index supports `SELECT DISTINCT category ... ORDER BY category` in
    // loadAllCategories(), which runs on every recording-detail read and every
    // inbox mutation. Without this, the DISTINCT+sort degrades to a full
    // table scan of recordings as the dataset grows.
    d.prepare("CREATE INDEX IF NOT EXISTS idx_recordings_category ON recordings(category)").run();

    d.prepare(`
      CREATE TABLE IF NOT EXISTS recording_jira_links (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        issue_key     TEXT NOT NULL,
        issue_url     TEXT,
        relation      TEXT NOT NULL DEFAULT 'created_from',
        created_at    INTEGER NOT NULL,
        UNIQUE(recording_id, issue_key)
      )
    `).run();
    d.prepare("CREATE INDEX IF NOT EXISTS idx_jira_links_recording ON recording_jira_links(recording_id)").run();

    d.prepare(`
      CREATE TABLE IF NOT EXISTS recording_tags (
        recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        tag           TEXT NOT NULL,
        PRIMARY KEY (recording_id, tag)
      )
    `).run();
    d.prepare("CREATE INDEX IF NOT EXISTS idx_tags_tag ON recording_tags(tag)").run();
  })();
}

interface RecordingDbRow {
  id: string;
  filename: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  filesize_bytes: number;
  serial_number: string;
  folder: string;
  audio_path: string | null;
  transcript_path: string | null;
  summary_path: string | null;
  metadata_path: string | null;
  audio_downloaded_at: number | null;
  transcript_downloaded_at: number | null;
  webhook_audio_fired_at: number | null;
  webhook_transcript_fired_at: number | null;
  is_trash: number;
  is_historical: number;
  last_error: string | null;
  metadata_json: string | null;
  transcript_text: string | null;
  inbox_status: string;
  inbox_notes: string | null;
  reviewed_at: number | null;
  category: string | null;
  snoozed_until: number | null;
  channel_notified_at: number | null;
}

function statusOf(row: RecordingDbRow): RecordingStatus {
  if (row.is_historical && !row.audio_downloaded_at) return "historical";
  if (!row.audio_downloaded_at) return "pending_audio";
  if (row.last_error) return "error";
  if (!row.transcript_downloaded_at) return "pending_transcript";
  return "complete";
}

// Mirrors the inbox-mcp semantics exactly: "snoozed" is not a real inbox_status
// value — it's inbox_status='new' with snoozed_until in the future. Computing it
// here keeps the client from needing its own clock that could drift from the DB.
export function effectiveInboxStatus(
  row: Pick<RecordingDbRow, "inbox_status" | "snoozed_until">,
  now: number = Date.now(),
): EffectiveInboxStatus {
  if (row.inbox_status === "new" && row.snoozed_until != null && row.snoozed_until > now) {
    return "snoozed";
  }
  return row.inbox_status as InboxStatus;
}

// `now` is optional — list queries thread the same `now` they used for the
// snooze filter through to `effectiveInboxStatus` so filter results and per-
// row statuses agree at the snooze-expiry boundary. Callers fetching a single
// row don't need this coordination and can omit it.
export function rowToRecording(
  row: RecordingDbRow,
  tags: string[] = [],
  now?: number,
): RecordingRow {
  return {
    id: row.id,
    filename: row.filename,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMs: row.duration_ms,
    filesizeBytes: row.filesize_bytes,
    serialNumber: row.serial_number,
    folder: row.folder,
    audioPath: row.audio_path,
    transcriptPath: row.transcript_path,
    summaryPath: row.summary_path,
    metadataPath: row.metadata_path,
    audioDownloadedAt: row.audio_downloaded_at,
    transcriptDownloadedAt: row.transcript_downloaded_at,
    webhookAudioFiredAt: row.webhook_audio_fired_at,
    webhookTranscriptFiredAt: row.webhook_transcript_fired_at,
    isTrash: row.is_trash === 1,
    isHistorical: row.is_historical === 1,
    lastError: row.last_error,
    status: statusOf(row),
    inboxStatus: row.inbox_status as InboxStatus,
    effectiveInboxStatus: effectiveInboxStatus(row, now),
    category: row.category,
    snoozedUntil: row.snoozed_until,
    reviewedAt: row.reviewed_at,
    tags,
  };
}

// Batch-load tags for a set of recording IDs to avoid N+1 when rendering the
// list. Returns a Map keyed by recording_id; recordings with no tags get [].
export function loadTagsForRecordings(ids: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (ids.length === 0) return result;
  const db = getDb();
  // better-sqlite3 caches prepared statements, but the IN-clause arity changes
  // per call, so we build the placeholder list each time. Small cost, acceptable
  // for dashboard pagination (limit 500 max).
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare<string[], { recording_id: string; tag: string }>(
      `SELECT recording_id, tag FROM recording_tags WHERE recording_id IN (${placeholders}) ORDER BY tag`,
    )
    .all(...ids);
  for (const id of ids) result.set(id, []);
  for (const r of rows) {
    const existing = result.get(r.recording_id);
    if (existing) existing.push(r.tag);
  }
  return result;
}

export function loadTagsForRecording(id: string): string[] {
  const db = getDb();
  return (db
    .prepare<[string], { tag: string }>(
      "SELECT tag FROM recording_tags WHERE recording_id = ? ORDER BY tag",
    )
    .all(id)).map((r) => r.tag);
}

export function loadJiraLinksForRecording(id: string): JiraLink[] {
  const db = getDb();
  const rows = db
    .prepare<
      [string],
      {
        id: number;
        issue_key: string;
        issue_url: string | null;
        relation: string;
        created_at: number;
      }
    >(
      "SELECT id, issue_key, issue_url, relation, created_at FROM recording_jira_links WHERE recording_id = ? ORDER BY created_at DESC",
    )
    .all(id);
  return rows.map((r) => ({
    id: r.id,
    issueKey: r.issue_key,
    issueUrl: r.issue_url,
    relation: r.relation,
    createdAt: r.created_at,
  }));
}

export function loadAllTags(): string[] {
  const db = getDb();
  return (db
    .prepare<[], { tag: string }>("SELECT DISTINCT tag FROM recording_tags ORDER BY tag")
    .all()).map((r) => r.tag);
}

export function loadAllCategories(): string[] {
  const db = getDb();
  return (db
    .prepare<[], { category: string }>(
      "SELECT DISTINCT category FROM recordings WHERE category IS NOT NULL AND category <> '' ORDER BY category",
    )
    .all()).map((r) => r.category);
}

export type { RecordingDbRow };
