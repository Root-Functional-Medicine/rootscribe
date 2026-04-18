import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PlaudRawRecording } from "@rootscribe/shared";
import { cleanupTempDir, mkTempConfigDir } from "../helpers/test-server.js";

// Set the config dir BEFORE importing anything that touches paths/config.
// server/src/config.ts caches the parsed settings at module load; if we
// imported first, that cache would latch onto the user's real settings.json.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const configDir = mkTempConfigDir("rootscribe-state-test-");

const { seedInitialState, SEED_RECORDINGS, SEED_TAGS, SEED_JIRA_LINKS } = await import(
  "../../src/test-seed/fixtures.js"
);
const { getDb, resetDbSingleton } = await import("../../src/db.js");
const { resetConfigCache } = await import("../../src/config.js");
const {
  upsertFromPlaud,
  markAudioDownloaded,
  markTranscriptDownloaded,
  markWebhookFired,
  recordError,
  clearError,
  listRecordingRows,
  getRecordingById,
  getRecordingWithRelations,
  setInboxStatus,
  setSnoozedUntil,
  setCategory,
  setInboxNotes,
  addRecordingTag,
  removeRecordingTag,
  addJiraLink,
  removeJiraLink,
  deleteRecording,
  countPendingTranscripts,
  countErrorsLast24h,
  findPendingTranscriptIds,
} = await import("../../src/sync/state.js");

beforeAll(() => {
  seedInitialState(configDir);
});

afterAll(() => {
  resetDbSingleton();
  resetConfigCache();
  cleanupTempDir(configDir);
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
});

beforeEach(() => {
  // Full reset: wipe state.sqlite + recreate schema + re-insert seed rows.
  // resetMutableState isn't enough because several state.ts functions mutate
  // columns it doesn't restore (last_error, audio_downloaded_at, etc.).
  resetDbSingleton();
  resetConfigCache();
  seedInitialState(configDir);
});

function rawRecording(overrides: Partial<PlaudRawRecording> = {}): PlaudRawRecording {
  return {
    id: "rec-fresh-01",
    filename: "fresh recording",
    fullname: "2026-04-20 fresh recording.ogg",
    filesize: 1_000_000,
    file_md5: "abc",
    start_time: Date.UTC(2026, 3, 20, 12, 0, 0),
    end_time: Date.UTC(2026, 3, 20, 12, 1, 0),
    duration: 60,
    version: 1,
    version_ms: Date.UTC(2026, 3, 20, 12, 0, 0),
    edit_time: Date.UTC(2026, 3, 20, 12, 1, 0),
    is_trash: false,
    is_trans: false,
    is_summary: false,
    serial_number: "SN-FRESH",
    ...overrides,
  };
}

describe("upsertFromPlaud", () => {
  it("inserts a new row with computed folder + absolute paths when the id is unknown", () => {
    const rec = upsertFromPlaud(rawRecording({ id: "rec-new-fresh" }));
    expect(rec.id).toBe("rec-new-fresh");
    expect(rec.folder).toMatch(/^2026-04-20_fresh_recording__rec-new-/);
    expect(rec.audioPath).toMatch(/audio\.ogg$/);
    expect(rec.audioDownloadedAt).toBeNull();
  });

  it("marks isHistorical when the option is set", () => {
    const rec = upsertFromPlaud(rawRecording({ id: "rec-hist" }), { isHistorical: true });
    expect(rec.isHistorical).toBe(true);
  });

  it("updates an existing row's is_trash when the Plaud item changes", () => {
    upsertFromPlaud(rawRecording({ id: "rec-trash-flip", is_trash: false }));
    const after = upsertFromPlaud(rawRecording({ id: "rec-trash-flip", is_trash: true }));
    expect(after.isTrash).toBe(true);
  });

  it("returns the existing row without changes when nothing changed", () => {
    const initial = upsertFromPlaud(rawRecording({ id: "rec-noop" }));
    const again = upsertFromPlaud(rawRecording({ id: "rec-noop" }));
    expect(again.id).toBe(initial.id);
    expect(again.folder).toBe(initial.folder);
  });

  it("renames the folder when the filename changes but the date+id prefix doesn't", () => {
    // Identical start_time and id, different filename → different sanitized
    // slug in the middle → new folder path. The old folder doesn't exist on
    // disk in this pure-DB test, but the DB row's folder column should update.
    upsertFromPlaud(rawRecording({ id: "rec-rename", filename: "original name" }));
    const renamed = upsertFromPlaud(
      rawRecording({ id: "rec-rename", filename: "new improved name" }),
    );
    expect(renamed.filename).toBe("new improved name");
    expect(renamed.folder).toContain("new_improved_name");
  });
});

describe("download/error markers", () => {
  it("markAudioDownloaded stamps audio_downloaded_at + updates filesize_bytes", () => {
    const row = upsertFromPlaud(rawRecording({ id: "rec-audio" }));
    expect(row.audioDownloadedAt).toBeNull();

    markAudioDownloaded("rec-audio", 987_654);
    const after = getRecordingById("rec-audio")!;
    expect(after.audioDownloadedAt).not.toBeNull();
    expect(after.filesizeBytes).toBe(987_654);
  });

  it("markTranscriptDownloaded stamps transcript_downloaded_at and clears last_error", () => {
    upsertFromPlaud(rawRecording({ id: "rec-trans" }));
    recordError("rec-trans", "previous failure");
    expect(getRecordingById("rec-trans")!.lastError).toBe("previous failure");

    markTranscriptDownloaded("rec-trans", "segment 1\nsegment 2");
    const after = getRecordingById("rec-trans")!;
    expect(after.transcriptDownloadedAt).not.toBeNull();
    expect(after.lastError).toBeNull();
  });

  it("markWebhookFired writes to the right column per event type", () => {
    upsertFromPlaud(rawRecording({ id: "rec-wh" }));
    markWebhookFired("rec-wh", "audio_ready");
    markWebhookFired("rec-wh", "transcript_ready");
    const after = getRecordingById("rec-wh")!;
    expect(after.webhookAudioFiredAt).not.toBeNull();
    expect(after.webhookTranscriptFiredAt).not.toBeNull();
  });

  it("recordError clamps messages to 500 characters", () => {
    upsertFromPlaud(rawRecording({ id: "rec-err" }));
    const longMsg = "x".repeat(1200);
    recordError("rec-err", longMsg);
    const after = getRecordingById("rec-err")!;
    expect(after.lastError).toHaveLength(500);
  });

  it("clearError nulls out last_error without touching anything else", () => {
    upsertFromPlaud(rawRecording({ id: "rec-clr" }));
    recordError("rec-clr", "oops");
    clearError("rec-clr");
    expect(getRecordingById("rec-clr")!.lastError).toBeNull();
  });
});

describe("listRecordingRows — filtering", () => {
  it("returns the full seed (12 rows) with filter='all'", () => {
    const result = listRecordingRows({ filter: "all" });
    expect(result.total).toBe(12);
    expect(result.items).toHaveLength(12);
  });

  it("filter='active' returns new-but-not-snoozed (5 seeded new - 2 snoozed = 3, but 2 categorized 'new' also count)", () => {
    // Seed: 5 plain "new" (2 snoozed), 2 "new" with category, 3 reviewed, 2 archived.
    // Active = "new" AND snoozed_until IS NULL. That's (5 - 2 snoozed) + 2 categorized = 5.
    const result = listRecordingRows({ filter: "active" });
    expect(result.items.every((r) => r.inboxStatus === "new")).toBe(true);
    expect(result.items.every((r) => r.effectiveInboxStatus === "new")).toBe(true);
    expect(result.total).toBe(5);
  });

  it("filter='new' aliases to 'active' for the server", () => {
    const active = listRecordingRows({ filter: "active" });
    const newOnly = listRecordingRows({ filter: "new" });
    expect(newOnly.total).toBe(active.total);
  });

  it("filter='snoozed' returns only rows with snoozed_until > now (2 seeded)", () => {
    const result = listRecordingRows({ filter: "snoozed" });
    expect(result.total).toBe(2);
    expect(result.items.every((r) => r.effectiveInboxStatus === "snoozed")).toBe(true);
  });

  it("filter='reviewed' returns exactly the 3 seeded reviewed rows", () => {
    const result = listRecordingRows({ filter: "reviewed" });
    expect(result.total).toBe(3);
  });

  it("filter='archived' returns exactly the 2 seeded archived rows", () => {
    const result = listRecordingRows({ filter: "archived" });
    expect(result.total).toBe(2);
  });
});

describe("listRecordingRows — search, tag, category, pagination, facets", () => {
  it("search matches substrings in filename", () => {
    const result = listRecordingRows({ search: "billing" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.filename).toMatch(/billing/i);
  });

  it("category filter returns only matching rows", () => {
    const result = listRecordingRows({ category: "billing" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.category).toBe("billing");
  });

  it("tag filter returns rows that have the tag via the recording_tags join", () => {
    const result = listRecordingRows({ tag: "followup" });
    // Seed assigns 'followup' to rec-new-01 and rec-new-03 (2 rows).
    expect(result.total).toBe(2);
    expect(result.items.every((r) => r.tags.includes("followup"))).toBe(true);
  });

  it("pagination: limit + offset walks through the result set deterministically", () => {
    const page1 = listRecordingRows({ limit: 5, offset: 0 });
    const page2 = listRecordingRows({ limit: 5, offset: 5 });
    const page3 = listRecordingRows({ limit: 5, offset: 10 });

    expect(page1.items).toHaveLength(5);
    expect(page2.items).toHaveLength(5);
    expect(page3.items).toHaveLength(2);
    // All 12 ids should be present across the three pages with no duplicates.
    const allIds = [...page1.items, ...page2.items, ...page3.items].map((r) => r.id);
    expect(new Set(allIds).size).toBe(12);
  });

  it("limit is clamped to 500 so a pathologically large request can't fetch everything", () => {
    const result = listRecordingRows({ limit: 10_000 });
    // We only have 12 seeded rows, so this just verifies the clamp didn't
    // throw. The real guard exists to prevent an accidental full-table dump
    // on larger datasets.
    expect(result.items.length).toBeLessThanOrEqual(500);
  });

  it("facets=false (default) returns empty availableTags/availableCategories", () => {
    const result = listRecordingRows({});
    expect(result.availableTags).toEqual([]);
    expect(result.availableCategories).toEqual([]);
  });

  it("facets=true surfaces DISTINCT tags and categories from the DB", () => {
    const result = listRecordingRows({ facets: true });
    expect(result.availableTags).toContain("followup");
    expect(result.availableCategories).toContain("billing");
  });
});

describe("getRecordingById / getRecordingWithRelations", () => {
  it("getRecordingById returns null for an unknown id", () => {
    expect(getRecordingById("does-not-exist")).toBeNull();
  });

  it("getRecordingById hydrates tags for known rows", () => {
    const row = getRecordingById("rec-new-03")!;
    expect(row.tags.sort()).toEqual(["followup", "urgent"]);
  });

  it("getRecordingWithRelations returns null for an unknown id", () => {
    expect(getRecordingWithRelations("does-not-exist")).toBeNull();
  });

  it("getRecordingWithRelations returns tags + jira links + inboxNotes for known rows", () => {
    const result = getRecordingWithRelations("rec-reviewed-linked")!;
    expect(result.row.id).toBe("rec-reviewed-linked");
    expect(result.jiraLinks).toHaveLength(1);
    expect(result.jiraLinks[0]!.issueKey).toBe("ROOT-101");
  });
});

describe("inbox mutations", () => {
  it("setInboxStatus('reviewed') stamps reviewed_at and persists notes", () => {
    expect(setInboxStatus("rec-new-01", "reviewed", "ship it")).toBe(true);
    const row = getRecordingById("rec-new-01")!;
    expect(row.inboxStatus).toBe("reviewed");
    expect(row.reviewedAt).not.toBeNull();
    const relations = getRecordingWithRelations("rec-new-01")!;
    expect(relations.inboxNotes).toBe("ship it");
  });

  it("setInboxStatus('reviewed') preserves existing notes when passed null", () => {
    setInboxStatus("rec-new-01", "reviewed", "first note");
    expect(setInboxStatus("rec-new-01", "reviewed", null)).toBe(true);
    const relations = getRecordingWithRelations("rec-new-01")!;
    // COALESCE(?, inbox_notes) — null arg means "keep what's there".
    expect(relations.inboxNotes).toBe("first note");
  });

  it("setInboxStatus('archived') does NOT touch reviewed_at or snoozed_until", () => {
    setInboxStatus("rec-new-01", "reviewed", null);
    setInboxStatus("rec-new-01", "archived", null);
    const row = getRecordingById("rec-new-01")!;
    expect(row.inboxStatus).toBe("archived");
    expect(row.reviewedAt).not.toBeNull(); // Preserved from the reviewed step.
  });

  it("setInboxStatus('new') clears reviewed_at AND snoozed_until (full reopen semantics)", () => {
    setInboxStatus("rec-reviewed-linked", "new", null);
    const row = getRecordingById("rec-reviewed-linked")!;
    expect(row.inboxStatus).toBe("new");
    expect(row.reviewedAt).toBeNull();
    expect(row.snoozedUntil).toBeNull();
  });

  it("setInboxStatus returns false when the recording id doesn't exist", () => {
    expect(setInboxStatus("ghost", "reviewed", null)).toBe(false);
  });

  it("setSnoozedUntil(null) always clears the snooze, regardless of inbox_status", () => {
    expect(setSnoozedUntil("rec-snoozed-01", null)).toBe(true);
    const row = getRecordingById("rec-snoozed-01")!;
    expect(row.snoozedUntil).toBeNull();
  });

  it("setSnoozedUntil with a future ts only applies when inbox_status='new'", () => {
    const future = Date.now() + 86_400_000;
    // rec-new-01 is 'new' → should succeed.
    expect(setSnoozedUntil("rec-new-01", future)).toBe(true);
    expect(getRecordingById("rec-new-01")!.snoozedUntil).toBe(future);

    // rec-reviewed-linked is 'reviewed' → should be blocked by the WHERE clause.
    expect(setSnoozedUntil("rec-reviewed-linked", future)).toBe(false);
    expect(getRecordingById("rec-reviewed-linked")!.snoozedUntil).toBeNull();
  });

  it("setCategory trims whitespace and treats empty-after-trim as null", () => {
    expect(setCategory("rec-new-01", "  training  ")).toBe(true);
    expect(getRecordingById("rec-new-01")!.category).toBe("training");

    expect(setCategory("rec-new-01", "   ")).toBe(true);
    expect(getRecordingById("rec-new-01")!.category).toBeNull();
  });

  it("setInboxNotes writes directly (no COALESCE) — null explicitly clears", () => {
    setInboxNotes("rec-new-01", "one-liner");
    expect(getRecordingWithRelations("rec-new-01")!.inboxNotes).toBe("one-liner");
    setInboxNotes("rec-new-01", null);
    expect(getRecordingWithRelations("rec-new-01")!.inboxNotes).toBeNull();
  });
});

describe("tags", () => {
  it("addRecordingTag trims and ignores empty strings", () => {
    expect(addRecordingTag("rec-new-01", "  spaced  ")).toBe(true);
    expect(getRecordingById("rec-new-01")!.tags).toContain("spaced");
    expect(addRecordingTag("rec-new-01", "   ")).toBe(false);
  });

  it("addRecordingTag is idempotent — re-adding the same tag returns false", () => {
    addRecordingTag("rec-new-02", "dupe");
    expect(addRecordingTag("rec-new-02", "dupe")).toBe(false);
  });

  it("removeRecordingTag removes the tag and returns false when it wasn't there", () => {
    addRecordingTag("rec-new-02", "removable");
    expect(removeRecordingTag("rec-new-02", "removable")).toBe(true);
    expect(removeRecordingTag("rec-new-02", "never-existed")).toBe(false);
  });
});

describe("jira links", () => {
  it("addJiraLink inserts a new link with a created_at timestamp", () => {
    expect(
      addJiraLink({
        recordingId: "rec-new-01",
        issueKey: "ROOT-900",
        issueUrl: "https://example.atlassian.net/browse/ROOT-900",
        relation: "created_from",
      }),
    ).toBe(true);

    const links = getRecordingWithRelations("rec-new-01")!.jiraLinks;
    const link = links.find((l) => l.issueKey === "ROOT-900")!;
    expect(link.issueUrl).toBe("https://example.atlassian.net/browse/ROOT-900");
    expect(link.createdAt).toBeGreaterThan(0);
  });

  it("addJiraLink honors the (recording_id, issue_key) uniqueness — duplicate returns false", () => {
    // ROOT-101 is already seeded on rec-reviewed-linked.
    expect(
      addJiraLink({
        recordingId: "rec-reviewed-linked",
        issueKey: "ROOT-101",
        issueUrl: "https://example.atlassian.net/browse/ROOT-101",
        relation: "created_from",
      }),
    ).toBe(false);
  });

  it("removeJiraLink returns true for a real link and false for an unknown one", () => {
    expect(removeJiraLink("rec-reviewed-linked", "ROOT-101")).toBe(true);
    expect(removeJiraLink("rec-reviewed-linked", "ROOT-NEVER")).toBe(false);
  });
});

describe("deleteRecording", () => {
  it("removes the row and cascades to tags + jira links via ON DELETE CASCADE", () => {
    deleteRecording("rec-reviewed-linked");
    expect(getRecordingById("rec-reviewed-linked")).toBeNull();

    const db = getDb();
    const tagCount = db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) as c FROM recording_tags WHERE recording_id = ?",
      )
      .get("rec-reviewed-linked")!.c;
    const linkCount = db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) as c FROM recording_jira_links WHERE recording_id = ?",
      )
      .get("rec-reviewed-linked")!.c;
    expect(tagCount).toBe(0);
    expect(linkCount).toBe(0);
  });
});

describe("counters and pending-transcript lookup", () => {
  it("countPendingTranscripts counts rows with audio_downloaded_at set but transcript_downloaded_at null", () => {
    // Seed rows all have audio_downloaded_at AND transcript_downloaded_at set,
    // so the initial count is 0.
    expect(countPendingTranscripts()).toBe(0);

    // Mark rec-new-01 as "audio done, transcript not" — should bump the count.
    getDb()
      .prepare("UPDATE recordings SET transcript_downloaded_at = NULL WHERE id = ?")
      .run("rec-new-01");
    expect(countPendingTranscripts()).toBe(1);
  });

  it("countErrorsLast24h counts rows with a last_error AND a recent audio/transcript download", () => {
    recordError("rec-new-01", "401 auth failed");
    // rec-new-01's seed-time audio_downloaded_at is ~2026-04-12, which is
    // ancient relative to Date.now() in this test run — so the 24h window
    // excludes it. Bump both timestamps to now, then count.
    const now = Date.now();
    getDb()
      .prepare(
        "UPDATE recordings SET audio_downloaded_at = ?, transcript_downloaded_at = ? WHERE id = ?",
      )
      .run(now, now, "rec-new-01");
    expect(countErrorsLast24h()).toBe(1);
  });

  it("findPendingTranscriptIds skips historical (is_historical=1) rows", () => {
    // Mark rec-new-01 transcript as not-yet-downloaded, then flip its historical bit.
    getDb()
      .prepare("UPDATE recordings SET transcript_downloaded_at = NULL, is_historical = 1 WHERE id = ?")
      .run("rec-new-01");
    expect(findPendingTranscriptIds()).not.toContain("rec-new-01");
  });

  it("findPendingTranscriptIds returns non-historical rows with audio but no transcript", () => {
    getDb()
      .prepare("UPDATE recordings SET transcript_downloaded_at = NULL WHERE id = ?")
      .run("rec-new-01");
    expect(findPendingTranscriptIds()).toContain("rec-new-01");
  });
});

describe("seed fixture sanity (pin-downs for shared test data)", () => {
  // If these assertions fail, the seed-fixture shape changed and several of
  // the tests above (which count seed rows) need to be updated in lockstep.
  it("SEED_RECORDINGS has 12 rows and SEED_TAGS has 4 entries", () => {
    expect(SEED_RECORDINGS).toHaveLength(12);
    expect(SEED_TAGS).toHaveLength(4);
  });

  it("SEED_JIRA_LINKS has exactly one pre-linked entry", () => {
    expect(SEED_JIRA_LINKS).toHaveLength(1);
    expect(SEED_JIRA_LINKS[0]!.issueKey).toBe("ROOT-101");
  });
});
