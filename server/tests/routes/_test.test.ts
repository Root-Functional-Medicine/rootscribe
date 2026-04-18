import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import path from "node:path";
import { cleanupTempDir, makeTestApp, mkTempConfigDir } from "../helpers/test-server.js";
import { seedInitialState } from "../../src/test-seed/fixtures.js";

// Capture original env + establish a seeded config dir BEFORE importing any
// server module. Matches the pattern in tests/routes/config.test.ts: the
// module-level db + config caches latch on first call, so the env must be
// set and the DB must exist before the router module loads.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const configDir = mkTempConfigDir("rootscribe-test-routes-");
seedInitialState(configDir);

const { testRouter } = await import("../../src/routes/_test.js");
const { resetDbSingleton } = await import("../../src/db.js");
const { resetConfigCache } = await import("../../src/config.js");

const app = makeTestApp((a) => a.use("/api/_test", testRouter));

afterAll(() => {
  resetDbSingleton();
  resetConfigCache();
  cleanupTempDir(configDir);
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
});

describe("POST /api/_test/reset", () => {
  beforeEach(() => {
    // Every case starts from a fully-reset DB so test-mutations below don't
    // leak into the next assertion.
    resetDbSingleton();
  });

  it("returns 200 { ok: true } and restores inbox_status after a mutation", async () => {
    // Sanity: the router uses the production db singleton. Mutate via a raw
    // handle on the same file so the router sees our pollution after it
    // lazily re-opens the DB on the reset call.
    const raw = new Database(path.join(configDir, "state.sqlite"));
    raw.prepare("UPDATE recordings SET inbox_status = 'archived'").run();
    raw.close();

    const res = await request(app).post("/api/_test/reset");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const verify = new Database(path.join(configDir, "state.sqlite"));
    const count = verify
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) as c FROM recordings WHERE inbox_status = 'archived'",
      )
      .get()!.c;
    verify.close();

    // Only the 2 recordings that were seeded as 'archived' should remain so.
    expect(count).toBe(2);
  });
});

describe("POST /api/_test/fast-forward-snooze", () => {
  beforeEach(() => {
    resetDbSingleton();
  });

  it("shifts snoozed_until into the past for the given recording id", async () => {
    const res = await request(app)
      .post("/api/_test/fast-forward-snooze")
      .send({ recordingId: "rec-snoozed-01" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: 1 });

    const raw = new Database(path.join(configDir, "state.sqlite"));
    const row = raw
      .prepare<[string], { snoozed_until: number | null }>(
        "SELECT snoozed_until FROM recordings WHERE id = ?",
      )
      .get("rec-snoozed-01")!;
    raw.close();

    expect(row.snoozed_until).not.toBeNull();
    expect(row.snoozed_until!).toBeLessThan(Date.now());
  });

  it("honors an explicit snoozedUntilMs override", async () => {
    const explicit = 123456;
    const res = await request(app)
      .post("/api/_test/fast-forward-snooze")
      .send({ recordingId: "rec-snoozed-02", snoozedUntilMs: explicit });

    expect(res.status).toBe(200);

    const raw = new Database(path.join(configDir, "state.sqlite"));
    const row = raw
      .prepare<[string], { snoozed_until: number | null }>(
        "SELECT snoozed_until FROM recordings WHERE id = ?",
      )
      .get("rec-snoozed-02")!;
    raw.close();

    expect(row.snoozed_until).toBe(explicit);
  });

  it("rejects a body missing recordingId with 400", async () => {
    const res = await request(app).post("/api/_test/fast-forward-snooze").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("rejects a body with a non-integer snoozedUntilMs with 400", async () => {
    const res = await request(app)
      .post("/api/_test/fast-forward-snooze")
      .send({ recordingId: "rec-snoozed-01", snoozedUntilMs: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("returns changed: 0 when the recording id is unknown (UPDATE matches zero rows)", async () => {
    const res = await request(app)
      .post("/api/_test/fast-forward-snooze")
      .send({ recordingId: "not-a-real-id" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, changed: 0 });
  });
});

describe("production safety gate", () => {
  it("is only mounted when index.ts sees ROOTSCRIBE_E2E=1 (verified by reading the source)", async () => {
    // Index.ts guards the router mount behind `process.env.ROOTSCRIBE_E2E === "1"`.
    // We can't exercise index.ts's main() in a unit test (it binds ports and
    // opens a browser), so this test reads the source and pins the guard
    // string. A future refactor that accidentally removes the env check
    // will fail here before it ships.
    const { readFileSync } = await import("node:fs");
    const indexSrc = readFileSync(
      new URL("../../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(indexSrc).toMatch(/process\.env\[E2E_FLAG\]\s*===\s*"1"/);
    expect(indexSrc).toMatch(/const E2E_FLAG = "ROOTSCRIBE_E2E"/);
  });
});
