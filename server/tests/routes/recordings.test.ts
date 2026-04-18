import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  cleanupTempDir,
  makeTestApp,
  mkTempConfigDir,
} from "../helpers/test-server.js";

// Set the config dir BEFORE importing any server module that caches config
// or opens the DB singleton.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const configDir = mkTempConfigDir("rootscribe-recordings-route-");

const { seedInitialState } = await import("../../src/test-seed/fixtures.js");
const { recordingsRouter } = await import("../../src/routes/recordings.js");
const { resetDbSingleton } = await import("../../src/db.js");
const { resetConfigCache } = await import("../../src/config.js");

const app = makeTestApp((a) => a.use("/api/recordings", recordingsRouter));

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
  // Full reset between tests so mutations in one can't affect the next.
  resetDbSingleton();
  resetConfigCache();
  seedInitialState(configDir);
});

describe("GET /api/recordings", () => {
  it("returns all 12 seeded recordings with total + totalBytes aggregates", async () => {
    const res = await request(app).get("/api/recordings");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    expect(res.body.items).toHaveLength(12);
    expect(res.body.totalBytes).toBeGreaterThan(0);
  });

  it("honors ?filter=reviewed (3 seeded reviewed rows)", async () => {
    const res = await request(app).get("/api/recordings?filter=reviewed");
    expect(res.body.total).toBe(3);
    expect(res.body.items.every((r: { inboxStatus: string }) => r.inboxStatus === "reviewed")).toBe(
      true,
    );
  });

  it("ignores invalid filter values instead of throwing (parseFilter returns undefined)", async () => {
    // A client passing ?filter=bogus used to crash older backends. The parser
    // treats unknown values as undefined, which falls back to 'all'.
    const res = await request(app).get("/api/recordings?filter=not-a-filter");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
  });

  it("clamps a pathologically large ?limit to 500", async () => {
    const res = await request(app).get("/api/recordings?limit=99999999");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(500);
  });

  it("rejects NaN / non-finite limit by falling back to the default (100)", async () => {
    // Number("abc") is NaN; parseIntQuery returns the fallback. Without the
    // guard, SQLite would receive NaN as a bind parameter.
    const res = await request(app).get("/api/recordings?limit=abc");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(12); // seed < default 100
  });

  it("clamps a negative offset up to 0", async () => {
    const res = await request(app).get("/api/recordings?offset=-5");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(12);
  });

  it("trims whitespace off ?tag and ?category before querying", async () => {
    // Without trimming, %20foo%20 → " foo " wouldn't match the stored "foo".
    const res = await request(app).get("/api/recordings?tag=%20followup%20");
    expect(res.body.total).toBe(2);
  });

  it("treats all-whitespace ?category as absent (not filtered)", async () => {
    const res = await request(app).get("/api/recordings?category=%20%20%20");
    expect(res.body.total).toBe(12);
  });

  it("?facets=1 returns availableTags + availableCategories", async () => {
    const res = await request(app).get("/api/recordings?facets=1");
    expect(res.body.availableTags).toContain("followup");
    expect(res.body.availableCategories).toContain("billing");
  });

  it("default (?facets omitted) returns empty facet arrays", async () => {
    const res = await request(app).get("/api/recordings");
    expect(res.body.availableTags).toEqual([]);
    expect(res.body.availableCategories).toEqual([]);
  });

  it("search narrows results by filename substring", async () => {
    const res = await request(app).get("/api/recordings?search=billing");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].filename).toMatch(/billing/i);
  });
});

describe("GET /api/recordings/:id", () => {
  it("returns the full detail envelope for a known id", async () => {
    const res = await request(app).get("/api/recordings/rec-reviewed-linked");
    expect(res.status).toBe(200);
    expect(res.body.recording.id).toBe("rec-reviewed-linked");
    expect(res.body.recording.jiraLinks).toHaveLength(1);
    expect(res.body.recording.jiraLinks[0].issueKey).toBe("ROOT-101");
    expect(res.body.mediaBase).toMatch(/^\/media\//);
    expect(res.body.recordingsDir).toContain("recordings");
  });

  it("includes transcriptText from transcript.txt on disk when the file exists", async () => {
    // seedInitialState writes a short placeholder transcript.txt alongside
    // transcript.json — assert the route picks it up via path.dirname swap.
    const res = await request(app).get("/api/recordings/rec-new-01");
    expect(res.body.recording.transcriptText).toContain("placeholder transcript");
  });

  it("includes summaryMarkdown when a summary.md exists in the folder", async () => {
    // The seed doesn't write summary.md by default; simulate a recording that
    // has one by writing it into the seeded folder.
    const folder = "2026-04-12_standup_2026-04-12__rec-new-";
    writeFileSync(
      path.join(configDir, "recordings", folder, "summary.md"),
      "# Summary\n\nKey point one.",
    );
    // Force the server to read it by pointing summary_path at the new file.
    const { getDb } = await import("../../src/db.js");
    getDb()
      .prepare("UPDATE recordings SET summary_path = ? WHERE id = ?")
      .run(path.join(configDir, "recordings", folder, "summary.md"), "rec-new-01");

    const res = await request(app).get("/api/recordings/rec-new-01");
    expect(res.body.recording.summaryMarkdown).toContain("Key point one");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).get("/api/recordings/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not found");
  });

  it("tolerates malformed metadata.json without 500'ing the whole request", async () => {
    // The read is wrapped in try/catch — a corrupt file just yields null metadata.
    const folder = "2026-04-12_standup_2026-04-12__rec-new-";
    writeFileSync(
      path.join(configDir, "recordings", folder, "metadata.json"),
      "{ not valid json",
    );
    const res = await request(app).get("/api/recordings/rec-new-01");
    expect(res.status).toBe(200);
    expect(res.body.recording.metadata).toBeNull();
  });
});

describe("DELETE /api/recordings/:id", () => {
  it("deletes the row + attempts to rmSync the folder", async () => {
    const folder = "2026-04-12_standup_2026-04-12__rec-new-";
    const folderPath = path.join(configDir, "recordings", folder);
    expect(existsSync(folderPath)).toBe(true);

    const res = await request(app).delete("/api/recordings/rec-new-01");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Row gone from DB.
    const follow = await request(app).get("/api/recordings/rec-new-01");
    expect(follow.status).toBe(404);
    // Folder on disk cleaned up.
    expect(existsSync(folderPath)).toBe(false);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).delete("/api/recordings/ghost");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/recordings/:id/status", () => {
  it("accepts a valid status transition to 'reviewed' with notes", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/status")
      .send({ status: "reviewed", notes: "ship it" });

    expect(res.status).toBe(200);
    expect(res.body.recording.inboxStatus).toBe("reviewed");
    expect(res.body.recording.inboxNotes).toBe("ship it");
  });

  it("rejects an unknown status value with 400", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/status")
      .send({ status: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/new, reviewed, archived/);
  });

  it("rejects notes on non-reviewed transitions (contract match)", async () => {
    // The runtime ignores notes for new/archived, so the wire contract
    // rejects them to avoid surprising partial-write behavior.
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/status")
      .send({ status: "archived", notes: "too late for notes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notes may only be provided when status is 'reviewed'/);
  });

  it("rejects notes that aren't strings (e.g. an accidental object)", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/status")
      .send({ status: "reviewed", notes: { bad: "shape" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notes must be a string/);
  });

  it("normalizes empty/whitespace-only notes to null (so COALESCE won't bypass the clear rule)", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/status")
      .send({ status: "reviewed", notes: "   " });
    expect(res.status).toBe(200);
    expect(res.body.recording.inboxNotes).toBeNull();
  });

  it("is idempotent — re-applying the same status returns 200 (not 404)", async () => {
    await request(app)
      .patch("/api/recordings/rec-new-01/status")
      .send({ status: "reviewed" });
    const again = await request(app)
      .patch("/api/recordings/rec-new-01/status")
      .send({ status: "reviewed" });
    expect(again.status).toBe(200);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app)
      .patch("/api/recordings/ghost/status")
      .send({ status: "reviewed" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/recordings/:id/snooze", () => {
  it("rejects a body missing the snoozedUntil field with a 'required' error", async () => {
    const res = await request(app).patch("/api/recordings/rec-new-01/snooze").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("accepts snoozedUntil=null to clear the snooze", async () => {
    // rec-snoozed-01 starts with a future snoozed_until in the seed.
    const res = await request(app)
      .patch("/api/recordings/rec-snoozed-01/snooze")
      .send({ snoozedUntil: null });
    expect(res.status).toBe(200);
    expect(res.body.recording.snoozedUntil).toBeNull();
  });

  it("accepts a future epoch-ms timestamp for new recordings", async () => {
    const future = Date.now() + 86_400_000;
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/snooze")
      .send({ snoozedUntil: future });
    expect(res.status).toBe(200);
    expect(res.body.recording.snoozedUntil).toBe(future);
  });

  it("rejects a past timestamp (would silently no-op under the > now predicate)", async () => {
    const past = Date.now() - 60_000;
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/snooze")
      .send({ snoozedUntil: past });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in the future/);
  });

  it("rejects zero / NaN / non-number values with 400", async () => {
    const resZero = await request(app)
      .patch("/api/recordings/rec-new-01/snooze")
      .send({ snoozedUntil: 0 });
    expect(resZero.status).toBe(400);
    const resString = await request(app)
      .patch("/api/recordings/rec-new-01/snooze")
      .send({ snoozedUntil: "tomorrow" });
    expect(resString.status).toBe(400);
  });

  it("returns 409 when trying to snooze a non-'new' recording", async () => {
    const future = Date.now() + 86_400_000;
    const res = await request(app)
      .patch("/api/recordings/rec-reviewed-linked/snooze")
      .send({ snoozedUntil: future });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only snooze recordings in 'new' status/);
  });

  it("returns 404 when the recording doesn't exist", async () => {
    const res = await request(app)
      .patch("/api/recordings/ghost/snooze")
      .send({ snoozedUntil: null });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/recordings/:id/category", () => {
  it("accepts a non-empty string and returns the updated detail", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/category")
      .send({ category: "training" });
    expect(res.status).toBe(200);
    expect(res.body.recording.category).toBe("training");
  });

  it("accepts null to clear the category", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-cat-billing/category")
      .send({ category: null });
    expect(res.status).toBe(200);
    expect(res.body.recording.category).toBeNull();
  });

  it("rejects a request missing the category field", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/category")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("rejects a non-string, non-null category value", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/category")
      .send({ category: 123 });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app)
      .patch("/api/recordings/ghost/category")
      .send({ category: "x" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/recordings/:id/notes", () => {
  it("accepts a string and returns the updated detail", async () => {
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/notes")
      .send({ notes: "remember to follow up" });
    expect(res.status).toBe(200);
    expect(res.body.recording.inboxNotes).toBe("remember to follow up");
  });

  it("accepts null to clear notes (unlike PATCH /status which uses COALESCE)", async () => {
    await request(app).patch("/api/recordings/rec-new-01/notes").send({ notes: "first" });
    const res = await request(app)
      .patch("/api/recordings/rec-new-01/notes")
      .send({ notes: null });
    expect(res.status).toBe(200);
    expect(res.body.recording.inboxNotes).toBeNull();
  });

  it("rejects a body missing the notes field (required)", async () => {
    const res = await request(app).patch("/api/recordings/rec-new-01/notes").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app)
      .patch("/api/recordings/ghost/notes")
      .send({ notes: "x" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/recordings/:id/tags", () => {
  it("adds a tag and returns the updated detail", async () => {
    const res = await request(app)
      .post("/api/recordings/rec-new-02/tags")
      .send({ tag: "followup" });
    expect(res.status).toBe(200);
    expect(res.body.recording.tags).toContain("followup");
  });

  it("rejects a non-string / empty tag with 400", async () => {
    const emptyRes = await request(app)
      .post("/api/recordings/rec-new-02/tags")
      .send({ tag: "   " });
    expect(emptyRes.status).toBe(400);
    const typeRes = await request(app)
      .post("/api/recordings/rec-new-02/tags")
      .send({ tag: 42 });
    expect(typeRes.status).toBe(400);
  });

  it("returns 404 for an unknown recording id", async () => {
    const res = await request(app).post("/api/recordings/ghost/tags").send({ tag: "x" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/recordings/:id/tags/:tag", () => {
  it("removes an existing tag", async () => {
    // rec-new-01 starts with the "followup" seed tag.
    const res = await request(app).delete("/api/recordings/rec-new-01/tags/followup");
    expect(res.status).toBe(200);
    expect(res.body.recording.tags).not.toContain("followup");
  });

  it("trims the tag from the URL so /tags/%20followup%20 still matches", async () => {
    // URL-encoded spaces around the stored tag would otherwise silently no-op
    // against the canonical 'followup' row.
    const res = await request(app).delete("/api/recordings/rec-new-01/tags/%20followup%20");
    expect(res.status).toBe(200);
    expect(res.body.recording.tags).not.toContain("followup");
  });

  it("rejects a tag that's whitespace-only after trimming", async () => {
    const res = await request(app).delete("/api/recordings/rec-new-01/tags/%20%20");
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown recording id", async () => {
    const res = await request(app).delete("/api/recordings/ghost/tags/x");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/recordings/:id/jira-links", () => {
  it("creates a link with an uppercase-normalized key + http(s) URL", async () => {
    const res = await request(app)
      .post("/api/recordings/rec-new-01/jira-links")
      .send({
        issueKey: "root-202",
        issueUrl: "https://example.atlassian.net/browse/ROOT-202",
        relation: "created_from",
      });
    expect(res.status).toBe(200);
    const link = res.body.recording.jiraLinks.find(
      (l: { issueKey: string }) => l.issueKey === "ROOT-202",
    );
    expect(link).toBeDefined();
    expect(link.issueUrl).toBe("https://example.atlassian.net/browse/ROOT-202");
  });

  it("accepts a valid key with no URL (server stores null)", async () => {
    const res = await request(app)
      .post("/api/recordings/rec-new-01/jira-links")
      .send({ issueKey: "ROOT-300" });
    expect(res.status).toBe(200);
    const link = res.body.recording.jiraLinks.find(
      (l: { issueKey: string }) => l.issueKey === "ROOT-300",
    );
    expect(link.issueUrl).toBeNull();
  });

  it("rejects a javascript: URL (XSS defense — same scheme check as the web client)", async () => {
    const res = await request(app)
      .post("/api/recordings/rec-new-01/jira-links")
      .send({ issueKey: "ROOT-777", issueUrl: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http or https/);
  });

  it("rejects a malformed URL (new URL() throws)", async () => {
    const res = await request(app)
      .post("/api/recordings/rec-new-01/jira-links")
      .send({ issueKey: "ROOT-888", issueUrl: "not a url" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid absolute URL/);
  });

  it("rejects a key that doesn't match the Jira pattern", async () => {
    const res = await request(app)
      .post("/api/recordings/rec-new-01/jira-links")
      .send({ issueKey: "not a key" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid Jira key/);
  });

  it("rejects a non-string issueKey with 400", async () => {
    const res = await request(app)
      .post("/api/recordings/rec-new-01/jira-links")
      .send({ issueKey: 42 });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown recording id", async () => {
    const res = await request(app)
      .post("/api/recordings/ghost/jira-links")
      .send({ issueKey: "ROOT-1" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/recordings/:id/jira-links/:issueKey", () => {
  it("removes an existing link (case-normalized match)", async () => {
    // ROOT-101 is pre-seeded; URL path might come in lowercase. The server
    // uppercases before comparing, so both forms should work.
    const res = await request(app).delete(
      "/api/recordings/rec-reviewed-linked/jira-links/root-101",
    );
    expect(res.status).toBe(200);
    expect(
      res.body.recording.jiraLinks.find((l: { issueKey: string }) => l.issueKey === "ROOT-101"),
    ).toBeUndefined();
  });

  it("returns 404 for an unknown recording id", async () => {
    const res = await request(app).delete("/api/recordings/ghost/jira-links/ROOT-1");
    expect(res.status).toBe(404);
  });
});
