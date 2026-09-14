import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("ensureInstanceId — first-run UUID generation", () => {
  it("mints a UUID, persists it to settings.json, and returns it when none is configured", async () => {
    const { ensureInstanceId, loadConfig, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    const id = ensureInstanceId();

    // RFC 4122 v4 shape — what node:crypto randomUUID() produces.
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Persisted: a fresh read of settings.json (cache dropped) sees it.
    resetConfigCache();
    expect(loadConfig().instanceId).toBe(id);
    resetConfigCache();
  });

  it("is idempotent — a second call returns the same id without re-minting", async () => {
    const { ensureInstanceId, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    const first = ensureInstanceId();
    const second = ensureInstanceId();
    expect(second).toBe(first);
    resetConfigCache();
  });

  it("returns the operator-chosen id untouched when settings.json already has one", async () => {
    writeFileSync(
      path.join(tmpDir, "settings.json"),
      JSON.stringify({ instanceId: "allen-macbook" }),
    );
    const { ensureInstanceId, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    expect(ensureInstanceId()).toBe("allen-macbook");
    resetConfigCache();
  });
});

describe("ensureInstanceId — malformed settings.json is never overwritten", () => {
  it("returns a process-stable id but leaves the unparseable file untouched (no data loss on repair)", async () => {
    // Copilot review on PR #19: loadConfig()'s catch branch returns
    // DEFAULT_CONFIG, so an unconditional persist at startup would clobber a
    // corrupt-but-recoverable settings.json (token, webhook, ...) with
    // defaults + a UUID. The id must still be minted (the header is
    // mandatory) but only in memory.
    const settingsFile = path.join(tmpDir, "settings.json");
    const malformed = '{"token": "recoverable-by-hand", "webhook": {';
    writeFileSync(settingsFile, malformed);

    const { ensureInstanceId, loadConfig, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    const first = ensureInstanceId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // Stable for the lifetime of the process (deliveries keep one id)...
    expect(ensureInstanceId()).toBe(first);
    expect(loadConfig().instanceId).toBe(first);
    // ...but the corrupt file was NOT rewritten.
    expect(readFileSync(settingsFile, "utf8")).toBe(malformed);
    resetConfigCache();
  });
});
