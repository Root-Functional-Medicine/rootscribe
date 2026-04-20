import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Each case uses its own ROOTSCRIBE_CONFIG_DIR so module-level caches
// (loadConfig's `cached`) don't leak between tests.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const originalLogLevel = process.env.LOG_LEVEL;

// Mock logger so config.ts's `logger.error(...)` inside the catch block
// doesn't trigger an async pino destination write. Pino writes to
// configDir/rootscribe.log, which gets rmSync'd in afterEach — resulting
// in a race where the log flush hits an ENOENT on the deleted tmp dir.
vi.mock("./logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

let tmpDir: string;

beforeAll(() => {
  // Silencing the real logger is belt-and-suspenders in case the mock
  // above is bypassed by any test that dynamically re-imports.
  process.env.LOG_LEVEL = "silent";
});

afterAll(() => {
  if (originalLogLevel == null) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "rootscribe-cfg-test-"));
  process.env.ROOTSCRIBE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig — malformed settings.json", () => {
  it("falls back to DEFAULT_CONFIG when settings.json contains invalid JSON (catch branch)", async () => {
    // Hits the `catch { logger.error(...); cached = { ...DEFAULT_CONFIG } }`
    // branch at config.ts:21-25. JSON.parse throws on non-JSON content.
    writeFileSync(path.join(tmpDir, "settings.json"), "{not valid json");

    // Fresh module so `cached` latches onto this test's ROOTSCRIBE_CONFIG_DIR.
    const { loadConfig, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    const cfg = loadConfig();
    // DEFAULT_CONFIG ships setupComplete=false; a token would never be set
    // from a malformed file, so token:null also proves we took the fallback.
    expect(cfg.setupComplete).toBe(false);
    expect(cfg.token).toBeNull();
    resetConfigCache();
  });
});
