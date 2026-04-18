import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Mirrors the v4 rootscribe schema produced by `server/src/db.ts`. Kept in
// sync by eye — if the server migrations evolve, update this fixture too
// (these tests will loudly fail via inbox-mcp's `assertV4Schema` guard if the
// schema drifts out of date).
const V4_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS recordings (
     id TEXT PRIMARY KEY,
     filename TEXT NOT NULL,
     start_time INTEGER NOT NULL,
     end_time INTEGER NOT NULL DEFAULT 0,
     duration_ms INTEGER NOT NULL,
     filesize_bytes INTEGER NOT NULL DEFAULT 0,
     serial_number TEXT NOT NULL DEFAULT '',
     folder TEXT NOT NULL,
     audio_path TEXT,
     transcript_path TEXT,
     summary_path TEXT,
     metadata_path TEXT,
     audio_downloaded_at INTEGER,
     transcript_downloaded_at INTEGER,
     webhook_audio_fired_at INTEGER,
     webhook_transcript_fired_at INTEGER,
     is_trash INTEGER NOT NULL DEFAULT 0,
     is_historical INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     metadata_json TEXT,
     transcript_text TEXT,
     inbox_status TEXT NOT NULL DEFAULT 'new',
     inbox_notes TEXT,
     reviewed_at INTEGER,
     category TEXT,
     snoozed_until INTEGER,
     channel_notified_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_start_time ON recordings(start_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_inbox_status ON recordings(inbox_status, start_time DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_recordings_category ON recordings(category)`,
  `CREATE TABLE IF NOT EXISTS recording_jira_links (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
     issue_key     TEXT NOT NULL,
     issue_url     TEXT,
     relation      TEXT NOT NULL DEFAULT 'created_from',
     created_at    INTEGER NOT NULL,
     UNIQUE(recording_id, issue_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_jira_links_recording ON recording_jira_links(recording_id)`,
  `CREATE TABLE IF NOT EXISTS recording_tags (
     recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
     tag           TEXT NOT NULL,
     PRIMARY KEY (recording_id, tag)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tags_tag ON recording_tags(tag)`,
];

function runDdl(db: Database.Database, statements: string[]): void {
  for (const statement of statements) {
    db.prepare(statement).run();
  }
}

export function createFreshStateDb(configDir: string): string {
  mkdirSync(configDir, { recursive: true });
  const dbFile = path.join(configDir, "state.sqlite");
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  runDdl(db, V4_STATEMENTS);
  db.close();
  return dbFile;
}

export interface SeedRecording {
  id: string;
  filename: string;
  folder: string;
  start_time?: number;
  duration_ms?: number;
  transcript_path?: string | null;
  summary_path?: string | null;
  transcript_downloaded_at?: number | null;
  transcript_text?: string | null;
  inbox_status?: "new" | "reviewed" | "archived";
  category?: string | null;
  snoozed_until?: number | null;
  channel_notified_at?: number | null;
}

// Helper that distinguishes "no value provided" (use sensible default) from
// "caller passed null" (honor the null). `??` collapses both null and
// undefined, which hid tests that wanted to seed a pending-transcript
// recording. We treat explicit `undefined` the same as omission so
// `{ snoozed_until: undefined }` doesn't accidentally bind NULL into a
// NOT NULL column via better-sqlite3; callers who need NULL must pass it
// explicitly.
function pick<T>(obj: SeedRecording, key: keyof SeedRecording, fallback: T): T | null {
  const value = obj[key];
  return value === undefined ? fallback : (value as T | null);
}

export function seedRecording(
  dbFile: string,
  recording: SeedRecording,
): void {
  const db = new Database(dbFile);
  try {
    db.prepare(
      `INSERT INTO recordings (
        id, filename, folder, start_time, duration_ms,
        transcript_path, summary_path, transcript_downloaded_at, transcript_text,
        inbox_status, category, snoozed_until, channel_notified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recording.id,
      recording.filename,
      recording.folder,
      pick(recording, "start_time", Date.now()),
      pick(recording, "duration_ms", 60_000),
      pick(recording, "transcript_path", null),
      pick(recording, "summary_path", null),
      pick(recording, "transcript_downloaded_at", Date.now()),
      pick(recording, "transcript_text", null),
      recording.inbox_status ?? "new",
      pick(recording, "category", null),
      pick(recording, "snoozed_until", null),
      pick(recording, "channel_notified_at", null),
    );
  } finally {
    db.close();
  }
}

export function seedTags(
  dbFile: string,
  recordingId: string,
  tags: string[],
): void {
  const db = new Database(dbFile);
  try {
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO recording_tags (recording_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) stmt.run(recordingId, tag);
  } finally {
    db.close();
  }
}

export function truncateAll(dbFile: string): void {
  const db = new Database(dbFile);
  try {
    db.prepare("DELETE FROM recording_tags").run();
    db.prepare("DELETE FROM recording_jira_links").run();
    db.prepare("DELETE FROM recordings").run();
  } finally {
    db.close();
  }
}
