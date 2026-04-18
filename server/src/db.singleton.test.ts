import { afterAll, describe, expect, it } from "vitest";
import { cleanupTempDir, mkTempConfigDir } from "../tests/helpers/test-server.js";

// Pre-stage a disposable config dir so getDb() doesn't clobber the user's
// real state.sqlite. Must run before we import the db module so the paths
// module reads our dir on first dbPath() call.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const configDir = mkTempConfigDir("rootscribe-db-singleton-");

const { getDb, resetDbSingleton } = await import("./db.js");

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
});
