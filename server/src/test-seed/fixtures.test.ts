import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_BIND_PORT,
  SEED_CONFIG_BASE,
  SEED_JIRA_LINKS,
  SEED_RECORDINGS,
  SEED_TAGS,
  resetMutableState,
  resetSettingsToSeed,
  seedConfig,
  seedInitialState,
} from "./fixtures.js";

describe("SEED fixture data", () => {
  it("ships twelve recordings to support pagination at page size 10", () => {
    expect(SEED_RECORDINGS).toHaveLength(12);
  });

  it("has no duplicate recording ids", () => {
    const ids = SEED_RECORDINGS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every inbox_status value (new, reviewed, archived)", () => {
    const statuses = new Set(SEED_RECORDINGS.map((r) => r.inboxStatus));
    expect(statuses).toEqual(new Set(["new", "reviewed", "archived"]));
  });

  it("includes exactly two snoozed-in-the-future rows for the snooze filter", () => {
    const now = Date.UTC(2026, 3, 10); // 2026-04-10 — before the day(18) snooze.
    const snoozed = SEED_RECORDINGS.filter(
      (r) => r.snoozedUntilMs !== null && r.snoozedUntilMs > now,
    );
    expect(snoozed).toHaveLength(2);
  });

  it("ships at least one recording with a pre-existing Jira link (unlink journey)", () => {
    const linkedId = SEED_JIRA_LINKS[0]!.recordingId;
    expect(SEED_RECORDINGS.some((r) => r.id === linkedId)).toBe(true);
  });

  it("ships a reviewed recording with NO Jira link (link journey target)", () => {
    const linked = new Set(SEED_JIRA_LINKS.map((l) => l.recordingId));
    const unlinkedReviewed = SEED_RECORDINGS.filter(
      (r) => r.inboxStatus === "reviewed" && !linked.has(r.id),
    );
    expect(unlinkedReviewed.length).toBeGreaterThan(0);
  });

  it("distributes SEED_TAGS across at least three distinct recordings", () => {
    expect(new Set(SEED_TAGS.map((t) => t.recordingId)).size).toBeGreaterThanOrEqual(3);
  });

  it("defaults SEED_CONFIG_BASE to setupComplete=true and a placeholder token", () => {
    expect(SEED_CONFIG_BASE.setupComplete).toBe(true);
    expect(SEED_CONFIG_BASE.token).toMatch(/e2e/);
  });

  it("seedConfig() defaults bind.port to DEFAULT_BIND_PORT but honors an override", () => {
    expect(seedConfig().bind.port).toBe(DEFAULT_BIND_PORT);
    expect(seedConfig(9999).bind.port).toBe(9999);
  });
});

describe("seedInitialState", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "rootscribe-seed-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("writes settings.json with recordingsDir pointing inside the config dir", () => {
    seedInitialState(configDir);

    const settings = JSON.parse(
      readFileSync(path.join(configDir, "settings.json"), "utf8"),
    );
    expect(settings.setupComplete).toBe(true);
    expect(settings.recordingsDir).toBe(path.join(configDir, "recordings"));
    expect(settings.token).toBe("e2e-fake-token");
  });

  it("creates state.sqlite with every seed recording row", () => {
    seedInitialState(configDir);

    const db = new Database(path.join(configDir, "state.sqlite"));
    const rows = db
      .prepare<[], { id: string; inbox_status: string }>(
        "SELECT id, inbox_status FROM recordings ORDER BY id",
      )
      .all();
    db.close();

    expect(rows).toHaveLength(SEED_RECORDINGS.length);
    expect(rows.map((r) => r.id).sort()).toEqual(
      SEED_RECORDINGS.map((r) => r.id).sort(),
    );
  });

  it("inserts all SEED_TAGS and SEED_JIRA_LINKS", () => {
    seedInitialState(configDir);

    const db = new Database(path.join(configDir, "state.sqlite"));
    const tagCount = db
      .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM recording_tags")
      .get()!.c;
    const linkCount = db
      .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM recording_jira_links")
      .get()!.c;
    db.close();

    expect(tagCount).toBe(SEED_TAGS.length);
    expect(linkCount).toBe(SEED_JIRA_LINKS.length);
  });

  it("creates one folder per seed recording with transcript.txt/json and metadata.json", () => {
    seedInitialState(configDir);

    const recordingsDir = path.join(configDir, "recordings");
    for (const rec of SEED_RECORDINGS) {
      const folder = path.join(recordingsDir, rec.folder);
      expect(existsSync(folder)).toBe(true);
      expect(existsSync(path.join(folder, "transcript.txt"))).toBe(true);
      // transcript.json mirrors the path the seeded DB row's transcript_path
      // points at — must exist on disk or the media router 404s.
      expect(existsSync(path.join(folder, "transcript.json"))).toBe(true);
      expect(existsSync(path.join(folder, "metadata.json"))).toBe(true);
    }
  });

  it("is idempotent — calling twice does not throw and leaves a consistent row count", () => {
    seedInitialState(configDir);
    seedInitialState(configDir);

    const db = new Database(path.join(configDir, "state.sqlite"));
    const count = db
      .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM recordings")
      .get()!.c;
    db.close();

    // seedInitialState wipes state.sqlite (and its WAL/SHM siblings) before
    // creating a fresh DB, so the second call starts from an empty schema
    // and re-inserts the full seed set. The row count must match exactly
    // the seed size — proving we're not accumulating duplicates or leaving
    // rows from the first call.
    expect(count).toBe(SEED_RECORDINGS.length);
  });

  it("accepts a port override and writes it into settings.json", () => {
    seedInitialState(configDir, { port: 54321 });

    const settings = JSON.parse(
      readFileSync(path.join(configDir, "settings.json"), "utf8"),
    );
    expect(settings.bind.port).toBe(54321);
  });

  it("writes absolute audio/transcript/metadata paths into each recording row", () => {
    seedInitialState(configDir);

    const db = new Database(path.join(configDir, "state.sqlite"));
    const row = db
      .prepare<[string], { audio_path: string; transcript_path: string; metadata_path: string }>(
        "SELECT audio_path, transcript_path, metadata_path FROM recordings WHERE id = ?",
      )
      .get(SEED_RECORDINGS[0]!.id)!;
    db.close();

    const recordingsDir = path.join(configDir, "recordings");
    expect(path.isAbsolute(row.audio_path)).toBe(true);
    expect(row.audio_path.startsWith(recordingsDir)).toBe(true);
    expect(row.transcript_path.startsWith(recordingsDir)).toBe(true);
    expect(row.metadata_path.startsWith(recordingsDir)).toBe(true);
  });
});

describe("resetMutableState", () => {
  let configDir: string;
  let db: Database.Database;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "rootscribe-reset-"));
    seedInitialState(configDir);
    db = new Database(path.join(configDir, "state.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("restores inbox_status, snoozed_until, category, reviewed_at on every recording", () => {
    // Mutate everything out of spec...
    db.prepare(
      "UPDATE recordings SET inbox_status = 'archived', snoozed_until = NULL, category = 'trash', reviewed_at = 999, inbox_notes = 'dirty'",
    ).run();

    resetMutableState(db);

    for (const rec of SEED_RECORDINGS) {
      const row = db
        .prepare<[string], {
          inbox_status: string;
          snoozed_until: number | null;
          category: string | null;
          reviewed_at: number | null;
          inbox_notes: string | null;
        }>(
          "SELECT inbox_status, snoozed_until, category, reviewed_at, inbox_notes FROM recordings WHERE id = ?",
        )
        .get(rec.id)!;
      expect(row.inbox_status).toBe(rec.inboxStatus);
      expect(row.snoozed_until).toBe(rec.snoozedUntilMs);
      expect(row.category).toBe(rec.category);
      expect(row.reviewed_at).toBe(rec.reviewedAtMs);
      expect(row.inbox_notes).toBeNull();
    }
  });

  it("truncates recording_tags and re-inserts the seeded tags", () => {
    db.prepare("INSERT INTO recording_tags (recording_id, tag) VALUES ('rec-new-01', 'drifted-tag')").run();

    resetMutableState(db);

    const tags = db
      .prepare<[], { recording_id: string; tag: string }>(
        "SELECT recording_id, tag FROM recording_tags ORDER BY recording_id, tag",
      )
      .all();
    expect(tags).toHaveLength(SEED_TAGS.length);
    expect(tags.some((t) => t.tag === "drifted-tag")).toBe(false);
  });

  it("truncates recording_jira_links and re-inserts the seeded links", () => {
    db.prepare(
      "INSERT INTO recording_jira_links (recording_id, issue_key, relation, created_at) VALUES ('rec-reviewed-linked', 'EXTRA-1', 'created_from', 1)",
    ).run();

    resetMutableState(db);

    const links = db
      .prepare<[], { issue_key: string }>(
        "SELECT issue_key FROM recording_jira_links ORDER BY issue_key",
      )
      .all();
    expect(links.map((l) => l.issue_key)).toEqual(
      SEED_JIRA_LINKS.map((l) => l.issueKey).sort(),
    );
  });

  it("resetSettingsToSeed restores seeded keys while preserving bind.port", () => {
    // Simulate a test that mutated settings.json via the real config route
    // (e.g. the Settings journey that bumps pollIntervalMinutes to 5).
    const settingsFile = path.join(configDir, "settings.json");
    const dirty = {
      setupComplete: true,
      token: "leaked-token",
      pollIntervalMinutes: 5,
      jiraBaseUrl: "https://evil.example.com/browse/",
      webhook: { url: "https://leak.example.com", enabled: true },
      bind: { host: "127.0.0.1", port: 54321 },
      recordingsDir: path.join(configDir, "recordings"),
    };
    writeFileSync(settingsFile, JSON.stringify(dirty, null, 2));

    resetSettingsToSeed(configDir);

    const restored = JSON.parse(readFileSync(settingsFile, "utf8"));
    // Seeded keys are back to baseline...
    expect(restored.pollIntervalMinutes).toBe(SEED_CONFIG_BASE.pollIntervalMinutes);
    expect(restored.jiraBaseUrl).toBe(SEED_CONFIG_BASE.jiraBaseUrl);
    expect(restored.webhook).toBeNull();
    expect(restored.token).toBe(SEED_CONFIG_BASE.token);
    // ...but bind.port was preserved (so the running server isn't out of sync
    // with its own settings file).
    expect(restored.bind.port).toBe(54321);
  });

  it("resetSettingsToSeed falls back to DEFAULT_BIND_PORT when settings.json is missing", () => {
    // Freshly-minted configDir with no settings.json yet — the fallback path
    // matters because the server could call reset before seedInitialState
    // has ever written the file in some edge cases.
    const freshDir = mkdtempSync(path.join(tmpdir(), "rootscribe-reset-missing-"));
    try {
      resetSettingsToSeed(freshDir);
      const restored = JSON.parse(
        readFileSync(path.join(freshDir, "settings.json"), "utf8"),
      );
      expect(restored.bind.port).toBe(DEFAULT_BIND_PORT);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("is idempotent — calling it twice leaves the same row counts", () => {
    db.prepare("UPDATE recordings SET inbox_status = 'archived'").run();
    db.prepare("DELETE FROM recording_tags").run();

    resetMutableState(db);
    resetMutableState(db);

    const tagCount = db
      .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM recording_tags")
      .get()!.c;
    const linkCount = db
      .prepare<[], { c: number }>("SELECT COUNT(*) as c FROM recording_jira_links")
      .get()!.c;
    expect(tagCount).toBe(SEED_TAGS.length);
    expect(linkCount).toBe(SEED_JIRA_LINKS.length);
  });
});
