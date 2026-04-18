import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFreshStateDb,
  seedRecording,
  seedTags,
  truncateAll,
} from "./helpers/schema.js";

// Capture the caller's original APPLAUD_CONFIG_DIR before overriding it, so
// afterAll can restore it. Otherwise subsequent tests in the same Vitest
// worker would see a path pointing at our (deleted) temp dir.
const originalConfigDir = process.env.APPLAUD_CONFIG_DIR;

// Prepare an isolated config dir and pre-populate it with a v4 state.sqlite
// BEFORE the module imports below fire, because inbox-mcp's db.ts latches the
// DB path on first `getDb()` call and refuses to open a DB without v4 schema.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "inbox-mcp-db-test-"));
process.env.APPLAUD_CONFIG_DIR = tmpRoot;
const dbFile = createFreshStateDb(tmpRoot);

const {
  addTags,
  archive,
  categorize,
  getJiraLinks,
  getRecording,
  getTags,
  linkJira,
  listNew,
  markNotified,
  markReviewed,
  recent,
  removeTags,
  search,
  snooze,
  unlinkJira,
  unnotifiedNew,
  unsnooze,
} = await import("../src/db.js");

describe("inbox-mcp db", () => {
  beforeAll(() => {
    // First call lazy-initializes the module-level singleton against our fixture.
    listNew({});
  });

  beforeEach(() => {
    truncateAll(dbFile);
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    // Restore BEFORE the next test file observes an env pointing at a dir
    // that no longer exists.
    if (originalConfigDir == null) delete process.env.APPLAUD_CONFIG_DIR;
    else process.env.APPLAUD_CONFIG_DIR = originalConfigDir;
  });

  describe("listNew", () => {
    it("returns recordings with inbox_status='new' and a downloaded transcript", () => {
      seedRecording(dbFile, { id: "r1", filename: "one", folder: "f1" });
      seedRecording(dbFile, { id: "r2", filename: "two", folder: "f2" });
      const rows = listNew({});
      expect(rows.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    });

    it("excludes recordings whose transcript hasn't downloaded yet", () => {
      seedRecording(dbFile, {
        id: "pending",
        filename: "pending",
        folder: "f",
        transcript_downloaded_at: null,
      });
      expect(listNew({})).toHaveLength(0);
    });

    it("excludes currently-snoozed recordings but surfaces them again once the snooze expires", () => {
      const future = Date.now() + 60_000;
      const past = Date.now() - 60_000;
      seedRecording(dbFile, {
        id: "snoozed",
        filename: "snoozed",
        folder: "f",
        snoozed_until: future,
      });
      seedRecording(dbFile, {
        id: "expired-snooze",
        filename: "awake",
        folder: "f",
        snoozed_until: past,
      });
      expect(listNew({}).map((r) => r.id)).toEqual(["expired-snooze"]);
    });

    it("filters by category when provided", () => {
      seedRecording(dbFile, { id: "a", filename: "a", folder: "f", category: "work" });
      seedRecording(dbFile, { id: "b", filename: "b", folder: "f", category: "personal" });
      expect(listNew({ category: "work" }).map((r) => r.id)).toEqual(["a"]);
    });

    it("filters by tag (intersection with recording_tags)", () => {
      seedRecording(dbFile, { id: "a", filename: "a", folder: "f" });
      seedRecording(dbFile, { id: "b", filename: "b", folder: "f" });
      seedTags(dbFile, "a", ["urgent"]);
      seedTags(dbFile, "b", ["meh"]);
      expect(listNew({ tag: "urgent" }).map((r) => r.id)).toEqual(["a"]);
    });

    it("caps limit at 200 even when the caller asks for more", () => {
      for (let i = 0; i < 5; i++) {
        seedRecording(dbFile, { id: `r${i}`, filename: `r${i}`, folder: "f" });
      }
      const rows = listNew({ limit: 99_999 });
      expect(rows).toHaveLength(5);
    });
  });

  describe("recent", () => {
    it("returns reviewed and archived items when status filter is applied", () => {
      seedRecording(dbFile, { id: "new1", filename: "n", folder: "f", inbox_status: "new" });
      seedRecording(dbFile, { id: "rev1", filename: "r", folder: "f", inbox_status: "reviewed" });
      seedRecording(dbFile, { id: "arc1", filename: "a", folder: "f", inbox_status: "archived" });

      expect(recent({ status: "reviewed" }).map((r) => r.id)).toEqual(["rev1"]);
      expect(recent({ status: "archived" }).map((r) => r.id)).toEqual(["arc1"]);
      expect(recent({ status: "new" }).map((r) => r.id)).toEqual(["new1"]);
    });

    it("surfaces snoozed recordings as a virtual status", () => {
      const future = Date.now() + 60_000;
      seedRecording(dbFile, {
        id: "s1",
        filename: "s",
        folder: "f",
        inbox_status: "new",
        snoozed_until: future,
      });
      seedRecording(dbFile, {
        id: "n1",
        filename: "n",
        folder: "f",
        inbox_status: "new",
      });

      expect(recent({ status: "snoozed" }).map((r) => r.id)).toEqual(["s1"]);
      expect(recent({ status: "new" }).map((r) => r.id)).toEqual(["n1"]);
    });
  });

  describe("getRecording", () => {
    it("returns null for an unknown id", () => {
      expect(getRecording("never-existed")).toBeNull();
    });

    it("returns the row when the id exists", () => {
      seedRecording(dbFile, { id: "x", filename: "hello", folder: "f" });
      const row = getRecording("x");
      expect(row?.id).toBe("x");
      expect(row?.filename).toBe("hello");
    });
  });

  describe("search", () => {
    it("matches against filename (case-insensitive)", () => {
      seedRecording(dbFile, { id: "a", filename: "Meeting with Bob", folder: "f" });
      seedRecording(dbFile, { id: "b", filename: "Standup", folder: "f" });
      expect(search("meeting").map((r) => r.id)).toEqual(["a"]);
    });

    it("matches against transcript_text", () => {
      seedRecording(dbFile, {
        id: "a",
        filename: "audio",
        folder: "f",
        transcript_text: "Discussed the quarterly budget in detail.",
      });
      expect(search("quarterly").map((r) => r.id)).toEqual(["a"]);
    });

    it("treats SQL LIKE wildcards as literal characters via ESCAPE", () => {
      seedRecording(dbFile, { id: "a", filename: "50%_off", folder: "f" });
      seedRecording(dbFile, { id: "b", filename: "plain title", folder: "f" });
      // '%' would otherwise match anything — ensure ESCAPE makes it literal.
      expect(search("50%").map((r) => r.id)).toEqual(["a"]);
    });

    it("caps limit at 200", () => {
      for (let i = 0; i < 3; i++) {
        seedRecording(dbFile, { id: `r${i}`, filename: `rec${i}`, folder: "f" });
      }
      expect(search("rec", 99_999)).toHaveLength(3);
    });
  });

  describe("status mutations", () => {
    it("markReviewed flips inbox_status and merges notes (COALESCE preserves existing)", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      expect(markReviewed("x", "first pass done")).toBe(true);
      expect(getRecording("x")?.inbox_status).toBe("reviewed");
      expect(getRecording("x")?.inbox_notes).toBe("first pass done");

      // Passing null for notes should not overwrite the existing note.
      expect(markReviewed("x", null)).toBe(true);
      expect(getRecording("x")?.inbox_notes).toBe("first pass done");
    });

    it("markReviewed returns false for an unknown id", () => {
      expect(markReviewed("ghost", "x")).toBe(false);
    });

    it("archive flips status to 'archived'", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      expect(archive("x")).toBe(true);
      expect(getRecording("x")?.inbox_status).toBe("archived");
    });

    it("snooze only applies while status is still 'new'", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      expect(snooze("x", Date.now() + 60_000)).toBe(true);

      archive("x");
      expect(snooze("x", Date.now() + 60_000)).toBe(false);
    });

    it("unsnooze clears snoozed_until", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f", snoozed_until: Date.now() + 60_000 });
      expect(unsnooze("x")).toBe(true);
      expect(getRecording("x")?.snoozed_until).toBeNull();
    });

    it("categorize sets the category", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      expect(categorize("x", "work")).toBe(true);
      expect(getRecording("x")?.category).toBe("work");
    });

    it("categorize(null) clears the category", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f", category: "work" });
      expect(categorize("x", null)).toBe(true);
      expect(getRecording("x")?.category).toBeNull();
    });
  });

  describe("tags", () => {
    it("addTags inserts new tags and returns the count added", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      expect(addTags("x", ["a", "b", "c"])).toBe(3);
      expect(getTags("x")).toEqual(["a", "b", "c"]);
    });

    it("addTags ignores duplicates idempotently", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      addTags("x", ["a"]);
      expect(addTags("x", ["a", "b"])).toBe(1);
      expect(getTags("x")).toEqual(["a", "b"]);
    });

    it("removeTags removes only matching tags and returns the count", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      addTags("x", ["a", "b", "c"]);
      expect(removeTags("x", ["a", "z"])).toBe(1);
      expect(getTags("x")).toEqual(["b", "c"]);
    });
  });

  describe("jira links", () => {
    it("linkJira inserts and returns true the first time", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      expect(
        linkJira({
          recordingId: "x",
          issueKey: "DEVX-1",
          issueUrl: "https://example/DEVX-1",
          relation: "created_from",
        }),
      ).toBe(true);
      expect(getJiraLinks("x")).toHaveLength(1);
    });

    it("linkJira is idempotent on (recording_id, issue_key)", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      linkJira({ recordingId: "x", issueKey: "DEVX-1", issueUrl: null, relation: "created_from" });
      expect(
        linkJira({ recordingId: "x", issueKey: "DEVX-1", issueUrl: null, relation: "created_from" }),
      ).toBe(false);
      expect(getJiraLinks("x")).toHaveLength(1);
    });

    it("unlinkJira removes the link and returns true", () => {
      seedRecording(dbFile, { id: "x", filename: "x", folder: "f" });
      linkJira({ recordingId: "x", issueKey: "DEVX-1", issueUrl: null, relation: "created_from" });
      expect(unlinkJira("x", "DEVX-1")).toBe(true);
      expect(getJiraLinks("x")).toHaveLength(0);
    });
  });

  describe("notification bookkeeping", () => {
    it("unnotifiedNew returns 'new' recordings without a channel_notified_at", () => {
      seedRecording(dbFile, { id: "a", filename: "a", folder: "f" });
      seedRecording(dbFile, { id: "b", filename: "b", folder: "f", channel_notified_at: Date.now() });
      expect(unnotifiedNew().map((r) => r.id)).toEqual(["a"]);
    });

    it("markNotified sets channel_notified_at so the row no longer surfaces", () => {
      seedRecording(dbFile, { id: "a", filename: "a", folder: "f" });
      markNotified("a");
      expect(unnotifiedNew()).toHaveLength(0);
    });
  });
});
