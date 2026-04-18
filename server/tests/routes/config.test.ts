import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { cleanupTempDir, makeTestApp, mkTempConfigDir } from "../helpers/test-server.js";

// Capture the caller's original APPLAUD_CONFIG_DIR before the helper
// mutates process.env, so it can be restored in afterAll. Without this, a
// subsequent test in the same Vitest worker would see this suite's (now
// deleted) temp dir and either fail loudly or silently touch the user's
// real config.
const originalConfigDir = process.env.APPLAUD_CONFIG_DIR;

// Set APPLAUD_CONFIG_DIR BEFORE importing any server module so the config
// cache + db singleton point at a disposable temp directory for the whole
// suite. If we imported first, the module-level `cached` in server/src/config.ts
// would latch onto the user's real settings.json.
const configDir = mkTempConfigDir("applaud-config-route-");

const { configRouter } = await import("../../src/routes/config.js");
const { loadConfig, resetConfigCache } = await import("../../src/config.js");

const app = makeTestApp((a) => a.use("/api/config", configRouter));

describe("GET /api/config", () => {
  beforeAll(() => {
    resetConfigCache();
  });

  afterAll(() => {
    resetConfigCache();
    cleanupTempDir(configDir);
    // Restore BEFORE the next test file observes an env pointing at a dir
    // that no longer exists.
    if (originalConfigDir == null) delete process.env.APPLAUD_CONFIG_DIR;
    else process.env.APPLAUD_CONFIG_DIR = originalConfigDir;
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

  afterAll(() => {
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
