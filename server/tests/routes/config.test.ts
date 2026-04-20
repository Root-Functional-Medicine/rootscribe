import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTempDir, makeTestApp, mkTempConfigDir } from "../helpers/test-server.js";

// The testWebhook + poller imports inside routes/config.ts reach into
// other modules that make real network or start real timers. Mock them
// here so the POST /test-webhook and POST /complete-setup tests don't
// actually fire HTTP requests or kick off a sync loop.
vi.mock("../../src/webhook/post.js", () => ({
  testWebhook: vi.fn(),
}));
vi.mock("../../src/sync/poller.js", () => ({
  poller: { start: vi.fn(), stop: vi.fn() },
}));

// Capture the caller's original ROOTSCRIBE_CONFIG_DIR before the helper
// mutates process.env, so it can be restored in afterAll. Without this, a
// subsequent test in the same Vitest worker would see this suite's (now
// deleted) temp dir and either fail loudly or silently touch the user's
// real config.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;

// Set ROOTSCRIBE_CONFIG_DIR BEFORE importing any server module so the config
// cache + db singleton point at a disposable temp directory for the whole
// suite. If we imported first, the module-level `cached` in server/src/config.ts
// would latch onto the user's real settings.json.
const configDir = mkTempConfigDir("rootscribe-config-route-");

const { configRouter } = await import("../../src/routes/config.js");
const { loadConfig, resetConfigCache, updateConfig } = await import(
  "../../src/config.js"
);
const { testWebhook } = await import("../../src/webhook/post.js");
const { poller } = await import("../../src/sync/poller.js");

const app = makeTestApp((a) => a.use("/api/config", configRouter));

// File-level afterAll: runs AFTER every describe block in this file has
// finished. server/src/paths.ts reads ROOTSCRIBE_CONFIG_DIR on every call, so if
// we restored + deleted the temp dir in the GET block's afterAll, the POST
// block (which runs after in source order) would point at a nonexistent
// directory — or worse, at the caller's real config dir. Keeping the
// cleanup at file scope ensures the env + dir stay valid for the entire
// suite and only get torn down when Vitest moves to the next file.
afterAll(() => {
  resetConfigCache();
  cleanupTempDir(configDir);
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
});

describe("GET /api/config", () => {
  beforeAll(() => {
    resetConfigCache();
  });

  it("returns the default config on a fresh install (no settings.json yet)", async () => {
    const res = await request(app).get("/api/config");

    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({
      setupComplete: false,
      token: null,
      pollIntervalMinutes: 10,
      bind: { host: "127.0.0.1", port: 44471 },
    });
  });

  it("never leaks the raw token — only null or the redacted sentinel", async () => {
    const res = await request(app).get("/api/config");
    expect(res.body.config.token === null || res.body.config.token === "***REDACTED***").toBe(true);
  });
});

describe("POST /api/config (validation)", () => {
  beforeAll(() => {
    resetConfigCache();
  });

  it("accepts a valid pollIntervalMinutes within [1, 120]", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ pollIntervalMinutes: 5 });

    expect(res.status).toBe(200);
    expect(res.body.config.pollIntervalMinutes).toBe(5);
    expect(loadConfig().pollIntervalMinutes).toBe(5);
  });

  it("rejects pollIntervalMinutes below the minimum (1)", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ pollIntervalMinutes: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("rejects pollIntervalMinutes above the maximum (120)", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ pollIntervalMinutes: 999 });

    expect(res.status).toBe(400);
  });

  it("rejects a jiraBaseUrl with a non-http(s) scheme (XSS-adjacent defense)", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ jiraBaseUrl: "javascript:alert(1)" });

    expect(res.status).toBe(400);
  });

  it("rejects a jiraBaseUrl that is not a valid URL at all", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ jiraBaseUrl: "not a url" });

    expect(res.status).toBe(400);
  });

  it("accepts a valid https jiraBaseUrl", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ jiraBaseUrl: "https://example.atlassian.net/browse/" });

    expect(res.status).toBe(200);
    expect(res.body.config.jiraBaseUrl).toBe(
      "https://example.atlassian.net/browse/",
    );
  });

  it("accepts a webhook object with url + enabled + secret", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({
        webhook: {
          url: "https://hook.example.com/in",
          enabled: true,
          secret: "s3cret",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.config.webhook).toMatchObject({
      url: "https://hook.example.com/in",
      enabled: true,
      secret: "s3cret",
    });
  });

  it("defaults webhook.enabled=true when url is non-empty and enabled is omitted", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ webhook: { url: "https://hook.example.com/in" } });

    expect(res.status).toBe(200);
    expect(res.body.config.webhook.enabled).toBe(true);
  });

  it("rejects webhook.url that is not a URL", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ webhook: { url: "not-a-url" } });

    expect(res.status).toBe(400);
  });

  it("accepts a null webhook (user is clearing the setting)", async () => {
    const res = await request(app)
      .post("/api/config")
      .send({ webhook: null });

    expect(res.status).toBe(200);
    expect(res.body.config.webhook).toBeNull();
  });
});

describe("POST /api/config/test-webhook", () => {
  beforeEach(() => {
    vi.mocked(testWebhook).mockReset();
  });

  it("calls testWebhook() with the URL and returns its result verbatim", async () => {
    vi.mocked(testWebhook).mockResolvedValue({
      ok: true,
      statusCode: 200,
      bodySnippet: "pong",
      durationMs: 42,
    });

    const res = await request(app)
      .post("/api/config/test-webhook")
      .send({ url: "https://hook.example/v1/ingest" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      statusCode: 200,
      bodySnippet: "pong",
      durationMs: 42,
    });
    expect(vi.mocked(testWebhook)).toHaveBeenCalledWith(
      "https://hook.example/v1/ingest",
    );
  });

  it("returns 400 when the URL is not a valid URL", async () => {
    const res = await request(app)
      .post("/api/config/test-webhook")
      .send({ url: "not-a-url" });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(vi.mocked(testWebhook)).not.toHaveBeenCalled();
  });

  it("returns 400 when the URL field is missing entirely", async () => {
    const res = await request(app)
      .post("/api/config/test-webhook")
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/config/validate-recordings-dir", () => {
  // Use a distinct temp subdir so these tests don't collide with the
  // outer config dir. mkdir-recursive is used for the "auto-create"
  // branch; rmSync in afterEach cleans up whatever got made.
  const testDirRoot = path.join(configDir, "validate-dir");

  beforeAll(() => {
    resetConfigCache();
  });

  afterEach(() => {
    try {
      rmSync(testDirRoot, { recursive: true, force: true });
    } catch {
      // Best-effort — windows file locks can linger briefly.
    }
  });

  it("returns 400 when the path field is missing", async () => {
    const res = await request(app)
      .post("/api/config/validate-recordings-dir")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns ok + freeBytes + writable for an existing writable directory", async () => {
    mkdirSync(testDirRoot, { recursive: true });
    const res = await request(app)
      .post("/api/config/validate-recordings-dir")
      .send({ path: testDirRoot });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.absolutePath).toBe(path.resolve(testDirRoot));
    expect(res.body.writable).toBe(true);
    expect(typeof res.body.freeBytes).toBe("number");
    expect(res.body.freeBytes).toBeGreaterThan(0);
  });

  it("creates the directory when it doesn't exist and returns ok=true", async () => {
    const freshDir = path.join(testDirRoot, "newly-created");
    const res = await request(app)
      .post("/api/config/validate-recordings-dir")
      .send({ path: freshDir });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.absolutePath).toBe(path.resolve(freshDir));
  });

  it("returns ok=false when the path can't be created (ENOTDIR: target is inside a regular file)", async () => {
    // Fully sandboxed failure case: create a REGULAR file, then ask the
    // route to create a directory INSIDE it. mkdir-recursive fails with
    // ENOTDIR on every platform and every user (including root in CI
    // containers), and nothing gets written outside the suite's temp dir.
    //
    // Previously used a root-level path ("/this-should-not-exist…") which
    // can succeed in privileged CI containers, leaving stray directories
    // under "/" that the test doesn't clean up — Copilot flagged this in
    // PR #14 review.
    mkdirSync(testDirRoot, { recursive: true });
    const blockerFile = path.join(testDirRoot, "blocker-file");
    writeFileSync(blockerFile, "not a directory");
    const impossible = path.join(blockerFile, "subdir");

    const res = await request(app)
      .post("/api/config/validate-recordings-dir")
      .send({ path: impossible });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.exists).toBe(false);
    expect(res.body.error).toMatch(/cannot create/i);
  });

  it("resolves relative paths to absolutes", async () => {
    // Compute a relative path from process.cwd() into this suite's temp
    // sandbox. That way any directory the route creates lands under
    // testDirRoot (which afterEach rmSyncs), NOT in the repo root or
    // process.cwd() — where a raw "./relative-doesnt-matter" would land
    // and could collide with real project state. Copilot flagged the
    // original version in PR #14 review.
    mkdirSync(testDirRoot, { recursive: true });
    const sandboxedDir = path.join(testDirRoot, "relative-resolve-target");
    const relativeDir = path.relative(process.cwd(), sandboxedDir);

    const res = await request(app)
      .post("/api/config/validate-recordings-dir")
      .send({ path: relativeDir });

    expect(res.body.absolutePath).toBe(path.resolve(relativeDir));
    // testDirRoot's afterEach rmSync clears whatever the route wrote under
    // the sandbox — no per-test cleanup needed beyond the suite hook.
  });
});

describe("POST /api/config/complete-setup", () => {
  beforeEach(() => {
    resetConfigCache();
    vi.mocked(poller.start).mockClear();
  });

  it("returns 400 when no token is configured", async () => {
    // Start with a clean token/recordingsDir.
    updateConfig({ token: null, recordingsDir: null, setupComplete: false });

    const res = await request(app)
      .post("/api/config/complete-setup")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("token");
    expect(vi.mocked(poller.start)).not.toHaveBeenCalled();
  });

  it("returns 400 when token is set but recordingsDir is missing", async () => {
    updateConfig({ token: "tok", recordingsDir: null, setupComplete: false });

    const res = await request(app)
      .post("/api/config/complete-setup")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("recordingsDir");
    expect(vi.mocked(poller.start)).not.toHaveBeenCalled();
  });

  it("flips setupComplete=true, starts the poller, and returns ok when everything is configured", async () => {
    updateConfig({
      token: "tok",
      recordingsDir: "/tmp/recs",
      setupComplete: false,
    });

    const res = await request(app)
      .post("/api/config/complete-setup")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(loadConfig().setupComplete).toBe(true);
    expect(vi.mocked(poller.start)).toHaveBeenCalledTimes(1);
  });
});
