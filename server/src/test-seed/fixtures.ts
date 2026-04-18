import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Seed fixtures for the E2E-only /api/_test/reset handler and the
// Playwright globalSetup. NEVER import this from a production code path —
// index.ts guards all wiring behind ROOTSCRIBE_E2E=1.

export interface SeedRecording {
  id: string;
  filename: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  filesizeBytes: number;
  serialNumber: string;
  folder: string;
  inboxStatus: "new" | "reviewed" | "archived";
  snoozedUntilMs: number | null;
  category: string | null;
  reviewedAtMs: number | null;
}

export interface SeedTag {
  recordingId: string;
  tag: string;
}

export interface SeedJiraLink {
  recordingId: string;
  issueKey: string;
  issueUrl: string;
  relation: string;
  createdAtMs: number;
}

const BASE_TIME = Date.UTC(2026, 3, 1, 12, 0, 0); // 2026-04-01 12:00:00 UTC
const DAY_MS = 24 * 60 * 60 * 1000;

function day(offset: number): number {
  return BASE_TIME + offset * DAY_MS;
}

export const SEED_RECORDINGS: SeedRecording[] = [
  {
    id: "rec-new-01",
    filename: "standup 2026-04-12",
    startTimeMs: day(11),
    endTimeMs: day(11) + 300_000,
    durationMs: 300_000,
    filesizeBytes: 4_800_000,
    serialNumber: "SN-01",
    folder: "2026-04-12_standup_2026-04-12__rec-new-",
    inboxStatus: "new",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: null,
  },
  {
    id: "rec-new-02",
    filename: "one-on-one with Pat",
    startTimeMs: day(10),
    endTimeMs: day(10) + 600_000,
    durationMs: 600_000,
    filesizeBytes: 9_600_000,
    serialNumber: "SN-02",
    folder: "2026-04-11_one-on-one_with_Pat__rec-new-",
    inboxStatus: "new",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: null,
  },
  {
    id: "rec-new-03",
    filename: "customer call Acme Corp",
    startTimeMs: day(9),
    endTimeMs: day(9) + 900_000,
    durationMs: 900_000,
    filesizeBytes: 14_400_000,
    serialNumber: "SN-03",
    folder: "2026-04-10_customer_call_Acme_Corp__rec-new-",
    inboxStatus: "new",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: null,
  },
  {
    id: "rec-snoozed-01",
    filename: "Q2 planning draft",
    startTimeMs: day(8),
    endTimeMs: day(8) + 1_200_000,
    durationMs: 1_200_000,
    filesizeBytes: 19_200_000,
    serialNumber: "SN-04",
    snoozedUntilMs: day(18),
    inboxStatus: "new",
    category: null,
    reviewedAtMs: null,
    folder: "2026-04-09_Q2_planning_draft__rec-snooz",
  },
  {
    id: "rec-snoozed-02",
    filename: "architecture review notes",
    startTimeMs: day(7),
    endTimeMs: day(7) + 1_500_000,
    durationMs: 1_500_000,
    filesizeBytes: 24_000_000,
    serialNumber: "SN-05",
    snoozedUntilMs: day(18),
    inboxStatus: "new",
    category: null,
    reviewedAtMs: null,
    folder: "2026-04-08_architecture_review_notes__rec-snooz",
  },
  {
    id: "rec-reviewed-linked",
    filename: "incident retro 2026-04-05",
    startTimeMs: day(6),
    endTimeMs: day(6) + 1_800_000,
    durationMs: 1_800_000,
    filesizeBytes: 28_800_000,
    serialNumber: "SN-06",
    inboxStatus: "reviewed",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: day(6) + 1_800_000 + 3600_000,
    folder: "2026-04-07_incident_retro_2026-04-05__rec-revie",
  },
  {
    id: "rec-reviewed-unlinked",
    filename: "product sync 2026-04-04",
    startTimeMs: day(5),
    endTimeMs: day(5) + 900_000,
    durationMs: 900_000,
    filesizeBytes: 14_400_000,
    serialNumber: "SN-07",
    inboxStatus: "reviewed",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: day(5) + 3600_000,
    folder: "2026-04-06_product_sync_2026-04-04__rec-revie",
  },
  {
    id: "rec-reviewed-plain",
    filename: "brown bag Vitest 4 upgrade",
    startTimeMs: day(4),
    endTimeMs: day(4) + 2_400_000,
    durationMs: 2_400_000,
    filesizeBytes: 38_400_000,
    serialNumber: "SN-08",
    inboxStatus: "reviewed",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: day(4) + 3600_000,
    folder: "2026-04-05_brown_bag_Vitest_4_upgrade__rec-revie",
  },
  {
    id: "rec-archived-01",
    filename: "old 1-on-1 archive",
    startTimeMs: day(3),
    endTimeMs: day(3) + 300_000,
    durationMs: 300_000,
    filesizeBytes: 4_800_000,
    serialNumber: "SN-09",
    inboxStatus: "archived",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: null,
    folder: "2026-04-04_old_1_on_1_archive__rec-archi",
  },
  {
    id: "rec-archived-02",
    filename: "stale meeting recording",
    startTimeMs: day(2),
    endTimeMs: day(2) + 300_000,
    durationMs: 300_000,
    filesizeBytes: 4_800_000,
    serialNumber: "SN-10",
    inboxStatus: "archived",
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: null,
    folder: "2026-04-03_stale_meeting_recording__rec-archi",
  },
  {
    id: "rec-cat-billing",
    filename: "billing escalation call",
    startTimeMs: day(1),
    endTimeMs: day(1) + 900_000,
    durationMs: 900_000,
    filesizeBytes: 14_400_000,
    serialNumber: "SN-11",
    inboxStatus: "new",
    snoozedUntilMs: null,
    category: "billing",
    reviewedAtMs: null,
    folder: "2026-04-02_billing_escalation_call__rec-cat-",
  },
  {
    id: "rec-cat-support",
    filename: "support triage sync",
    startTimeMs: day(0),
    endTimeMs: day(0) + 600_000,
    durationMs: 600_000,
    filesizeBytes: 9_600_000,
    serialNumber: "SN-12",
    inboxStatus: "new",
    snoozedUntilMs: null,
    category: "support",
    reviewedAtMs: null,
    folder: "2026-04-01_support_triage_sync__rec-cat-",
  },
];

export const SEED_TAGS: SeedTag[] = [
  { recordingId: "rec-new-01", tag: "followup" },
  { recordingId: "rec-new-03", tag: "followup" },
  { recordingId: "rec-new-03", tag: "urgent" },
  { recordingId: "rec-cat-billing", tag: "billing" },
];

export const SEED_JIRA_LINKS: SeedJiraLink[] = [
  {
    recordingId: "rec-reviewed-linked",
    issueKey: "ROOT-101",
    issueUrl: "https://example.atlassian.net/browse/ROOT-101",
    relation: "created_from",
    createdAtMs: day(6) + 3600_000,
  },
];

export const SEED_CONFIG = {
  setupComplete: true,
  token: "e2e-fake-token",
  pollIntervalMinutes: 10,
  jiraBaseUrl: "https://example.atlassian.net/browse/",
  webhook: null,
  bind: { host: "127.0.0.1", port: 44471 },
} as const;

function silentOggPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "tests", "e2e", "fixtures", "silent.ogg");
}

function writeRecordingFiles(recordingsDir: string, rec: SeedRecording): void {
  const folder = path.join(recordingsDir, rec.folder);
  mkdirSync(folder, { recursive: true });
  const silent = silentOggPath();
  if (existsSync(silent)) copyFileSync(silent, path.join(folder, "audio.ogg"));
  writeFileSync(
    path.join(folder, "transcript.txt"),
    `[00:00] Speaker 1: placeholder transcript for ${rec.filename}\n[00:05] Speaker 2: end of placeholder.\n`,
  );
  writeFileSync(
    path.join(folder, "metadata.json"),
    JSON.stringify({ id: rec.id, filename: rec.filename }, null, 2),
  );
}

const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS recordings (
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
  "CREATE INDEX IF NOT EXISTS idx_recordings_start_time ON recordings(start_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_recordings_inbox_status ON recordings(inbox_status, start_time DESC)",
  "CREATE INDEX IF NOT EXISTS idx_recordings_category ON recordings(category)",
  `CREATE TABLE IF NOT EXISTS recording_jira_links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      issue_key     TEXT NOT NULL,
      issue_url     TEXT,
      relation      TEXT NOT NULL DEFAULT 'created_from',
      created_at    INTEGER NOT NULL,
      UNIQUE(recording_id, issue_key)
    )`,
  "CREATE INDEX IF NOT EXISTS idx_jira_links_recording ON recording_jira_links(recording_id)",
  `CREATE TABLE IF NOT EXISTS recording_tags (
      recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
      tag           TEXT NOT NULL,
      PRIMARY KEY (recording_id, tag)
    )`,
  "CREATE INDEX IF NOT EXISTS idx_tags_tag ON recording_tags(tag)",
  `CREATE TABLE IF NOT EXISTS webhook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recording_id TEXT,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      response_snippet TEXT,
      fired_at INTEGER NOT NULL,
      duration_ms INTEGER,
      error TEXT
    )`,
  "CREATE INDEX IF NOT EXISTS idx_webhook_log_fired_at ON webhook_log(fired_at DESC)",
];

function applySchema(d: Database.Database): void {
  for (const stmt of SCHEMA_DDL) d.prepare(stmt).run();
}

function insertSeedRows(d: Database.Database): void {
  const insertRecording = d.prepare(`
    INSERT INTO recordings (
      id, filename, start_time, end_time, duration_ms, filesize_bytes,
      serial_number, folder, audio_path, transcript_path, summary_path,
      metadata_path, audio_downloaded_at, transcript_downloaded_at,
      is_trash, is_historical, inbox_status, snoozed_until, category, reviewed_at
    ) VALUES (
      @id, @filename, @startTimeMs, @endTimeMs, @durationMs, @filesizeBytes,
      @serialNumber, @folder, @audioPath, @transcriptPath, NULL,
      @metadataPath, @startTimeMs, @startTimeMs,
      0, 0, @inboxStatus, @snoozedUntilMs, @category, @reviewedAtMs
    )
  `);

  const insertTag = d.prepare(
    "INSERT INTO recording_tags (recording_id, tag) VALUES (?, ?)",
  );

  const insertLink = d.prepare(`
    INSERT INTO recording_jira_links (recording_id, issue_key, issue_url, relation, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  d.transaction(() => {
    for (const rec of SEED_RECORDINGS) {
      insertRecording.run({
        ...rec,
        audioPath: `${rec.folder}/audio.ogg`,
        transcriptPath: `${rec.folder}/transcript.json`,
        metadataPath: `${rec.folder}/metadata.json`,
      });
    }
    for (const tag of SEED_TAGS) insertTag.run(tag.recordingId, tag.tag);
    for (const link of SEED_JIRA_LINKS) {
      insertLink.run(
        link.recordingId,
        link.issueKey,
        link.issueUrl,
        link.relation,
        link.createdAtMs,
      );
    }
  })();
}

export function seedInitialState(configDir: string): void {
  mkdirSync(configDir, { recursive: true });

  const recordingsDir = path.join(configDir, "recordings");
  mkdirSync(recordingsDir, { recursive: true });

  const settings = { ...SEED_CONFIG, recordingsDir };
  writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    { mode: 0o600 },
  );

  // Idempotency: wipe any pre-existing state.sqlite (plus its WAL/SHM
  // siblings) so repeat invocations start from a blank schema. Without
  // this, the second call hits UNIQUE constraint violations on the seed
  // INSERTs.
  const dbPath = path.join(configDir, "state.sqlite");
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(p)) rmSync(p, { force: true });
  }
  const fresh = new Database(dbPath);
  fresh.pragma("journal_mode = WAL");
  fresh.pragma("foreign_keys = ON");
  applySchema(fresh);
  insertSeedRows(fresh);
  fresh.close();

  for (const rec of SEED_RECORDINGS) writeRecordingFiles(recordingsDir, rec);
}

export function resetMutableState(d: Database.Database): void {
  d.transaction(() => {
    d.prepare("DELETE FROM recording_tags").run();
    d.prepare("DELETE FROM recording_jira_links").run();

    const resetRow = d.prepare(`
      UPDATE recordings
         SET inbox_status = @inboxStatus,
             snoozed_until = @snoozedUntilMs,
             category = @category,
             reviewed_at = @reviewedAtMs,
             inbox_notes = NULL
       WHERE id = @id
    `);
    for (const rec of SEED_RECORDINGS) {
      resetRow.run({
        id: rec.id,
        inboxStatus: rec.inboxStatus,
        snoozedUntilMs: rec.snoozedUntilMs,
        category: rec.category,
        reviewedAtMs: rec.reviewedAtMs,
      });
    }

    const insertTag = d.prepare(
      "INSERT INTO recording_tags (recording_id, tag) VALUES (?, ?)",
    );
    for (const tag of SEED_TAGS) insertTag.run(tag.recordingId, tag.tag);

    const insertLink = d.prepare(`
      INSERT INTO recording_jira_links (recording_id, issue_key, issue_url, relation, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const link of SEED_JIRA_LINKS) {
      insertLink.run(
        link.recordingId,
        link.issueKey,
        link.issueUrl,
        link.relation,
        link.createdAtMs,
      );
    }
  })();
}
