import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDir, mkTempConfigDir } from "./helpers/test-server.js";

// Pre-stage a disposable config dir so getDb() doesn't clobber the user's
// real state.sqlite. Must run before we import the db module so the paths
// module reads our dir on first dbPath() call.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const configDir = mkTempConfigDir("rootscribe-db-singleton-");

const { getDb, resetDbSingleton } = await import("../src/db.js");

afterAll(() => {
  resetDbSingleton();
  cleanupTempDir(configDir);
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
});

describe("resetDbSingleton", () => {
  it("returns a fresh handle after reset (not the same object)", () => {
    const first = getDb();
    resetDbSingleton();
    const second = getDb();

    expect(second).not.toBe(first);
  });

  it("tolerates being called when no handle has been cached yet", () => {
    resetDbSingleton();
    expect(() => resetDbSingleton()).not.toThrow();
  });

  it("leaves the on-disk file intact (reset closes the handle, does not drop data)", () => {
    const db = getDb();
    db.prepare(
      "INSERT OR REPLACE INTO recordings (id, filename, start_time, end_time, duration_ms, filesize_bytes, serial_number, folder) VALUES ('singleton-probe', 'probe', 1, 2, 1, 1, 'SN-P', 'p')",
    ).run();

    resetDbSingleton();

    const reopened = getDb();
    const row = reopened
      .prepare<[string], { id: string }>("SELECT id FROM recordings WHERE id = ?")
      .get("singleton-probe");
    expect(row?.id).toBe("singleton-probe");
  });

  it("keeps the bad handle cached when close() throws, so a second getDb() does not open a parallel connection", () => {
    // Bring a handle into the cache, then spy on close() to throw the way
    // better-sqlite3 does when open statements are still in flight. The
    // cache must NOT be nulled — nulling it would let the next getDb()
    // open a second connection against the same state.sqlite, which
    // risks file locks / FD leaks.
    const cached = getDb();
    const closeSpy = vi.spyOn(cached, "close").mockImplementation(() => {
      throw new Error("simulated: database is locked — open statements");
    });

    // Should NOT throw — resetDbSingleton swallows the close error and logs.
    expect(() => resetDbSingleton()).not.toThrow();

    // Next getDb() should return the SAME (still-cached) handle, not a new one,
    // because close() failed and we refused to null the cache.
    const stillCached = getDb();
    expect(stillCached).toBe(cached);

    closeSpy.mockRestore();
    // Actually close the handle so the rest of the suite starts clean.
    resetDbSingleton();
  });
});
