import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("ensureInstanceId — persisted value is validated like the API input", () => {
  it("re-mints and persists a safe id when settings.json holds a header-unsafe value", async () => {
    // Copilot review on PR #19 round 2: a hand-edited settings.json with a
    // control character would be stamped verbatim into x-rootscribe-instance,
    // where undici rejects it and every delivery fails. The persisted value
    // must pass the same [A-Za-z0-9._:-]{1,128} rule POST /api/config enforces.
    const settingsFile = path.join(tmpDir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ instanceId: "bad\nid" }));

    const { ensureInstanceId, loadConfig, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    const id = ensureInstanceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    resetConfigCache();
    expect(loadConfig().instanceId).toBe(id);
    resetConfigCache();
  });

  it("re-mints when the persisted value is over 128 characters or empty", async () => {
    const { ensureInstanceId, resetConfigCache } = await import("./config.js");
    for (const bad of ["a".repeat(129), "", "two words"]) {
      writeFileSync(path.join(tmpDir, "settings.json"), JSON.stringify({ instanceId: bad }));
      resetConfigCache();
      expect(ensureInstanceId(), `expected re-mint for ${JSON.stringify(bad)}`).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
    resetConfigCache();
  });
});

describe("ensureInstanceId — persistence failure must not become an outage", () => {
  // chmod-based read-only files are bypassed by root; GitHub-hosted runners
  // and developer machines are non-root, which is where this matters.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)("falls back to an in-memory id (no throw) when settings.json cannot be written", async () => {
    // Copilot review on PR #19 round 5: saveConfig() throwing (read-only
    // file, full disk) would surface in main() before listen() and, on the
    // delivery path, inside fireRaw's try before fetch — turning a readable
    // config into a startup or delivery outage just to add a header.
    const settingsFile = path.join(tmpDir, "settings.json");
    const original = JSON.stringify({ token: "t" });
    writeFileSync(settingsFile, original);
    chmodSync(settingsFile, 0o400);

    const { ensureInstanceId, loadConfig, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    let id = "";
    expect(() => {
      id = ensureInstanceId();
    }).not.toThrow();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Stable for the process even though it could not be persisted...
    expect(ensureInstanceId()).toBe(id);
    expect(loadConfig().instanceId).toBe(id);
    // ...and the file is exactly as it was.
    expect(readFileSync(settingsFile, "utf8")).toBe(original);
    chmodSync(settingsFile, 0o600);
    resetConfigCache();
  });
});

describe("ensureInstanceId — settings.json that parses but is not a plain object", () => {
  it.each([
    ["null", "null"],
    ["an array", "[1, 2]"],
    ["a string", JSON.stringify("just-a-string")],
    ["a number", "42"],
  ])("treats %s as a failed load: mints in memory, never rewrites the file", async (_label, content) => {
    // Copilot review on PR #19 round 7: `{ ...DEFAULT_CONFIG, ...parsed }`
    // accepts any JSON value, so a semantically corrupt file slipped past
    // the malformed-file guard and got overwritten with defaults + a UUID.
    const settingsFile = path.join(tmpDir, "settings.json");
    writeFileSync(settingsFile, content);

    const { ensureInstanceId, resetConfigCache } = await import("./config.js");
    resetConfigCache();

    expect(ensureInstanceId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(settingsFile, "utf8")).toBe(content);
    resetConfigCache();
  });
});
