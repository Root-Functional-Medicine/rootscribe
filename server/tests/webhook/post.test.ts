import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RecordingRow } from "@rootscribe/shared";
import { recordingRowFactory } from "@rootscribe/shared/test-factories";
import { cleanupTempDir, mkTempConfigDir } from "../helpers/test-server.js";

// Capture the caller's ROOTSCRIBE_CONFIG_DIR so afterAll can restore it.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;

// Set the env var BEFORE importing any server module so the config + db
// singletons latch onto the disposable temp directory for this suite only.
const configDir = mkTempConfigDir("rootscribe-webhook-post-");

const { fireWebhookForRecording, testWebhook } = await import(
  "../../src/webhook/post.js"
);
const { loadConfig, resetConfigCache, updateConfig } = await import(
  "../../src/config.js"
);
const { getDb, resetDbSingleton } = await import("../../src/db.js");

// Point config.recordingsDir at a known absolute location inside the temp
// dir so buildPayload can read transcript.txt / summary.md from a real
// place that this file controls.
const recordingsDir = path.join(configDir, "recordings");
mkdirSync(recordingsDir, { recursive: true });

afterAll(() => {
  resetConfigCache();
  resetDbSingleton();
  cleanupTempDir(configDir);
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
});

// Webhook-post scenarios all operate on rows where audio has already landed
// (audioDownloadedAt != null, audioPath set) — that's the precondition for
// fireWebhookForRecording to even run. The factory's base default is
// `complete` with nulls; we override the audio fields per-suite.
function makeRow(overrides: Partial<RecordingRow> = {}): RecordingRow {
  return recordingRowFactory.build({
    id: "rec-abc",
    filename: "standup.ogg",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_060_000,
    durationMs: 60_000,
    filesizeBytes: 1024,
    serialNumber: "SN1",
    folder: "2026-04-11_standup__abc",
    audioPath: "audio.ogg",
    audioDownloadedAt: Date.now(),
    ...overrides,
  });
}

function countWebhookLogRows(): number {
  return getDb()
    .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM webhook_log")
    .get()!.c;
}

describe("fireWebhookForRecording — guard clauses", () => {
  beforeEach(() => {
    resetConfigCache();
    resetDbSingleton();
    getDb(); // force init so webhook_log table exists.
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Wipe log rows between tests so counts are deterministic.
    getDb().prepare("DELETE FROM webhook_log").run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns false and does NOT call fetch when config.webhook is null", async () => {
    updateConfig({ webhook: null, recordingsDir });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ok = await fireWebhookForRecording("audio_ready", makeRow());
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(countWebhookLogRows()).toBe(0);
  });

  it("returns false when webhook.enabled is false even if url is present", async () => {
    updateConfig({
      webhook: { url: "https://hook.example", enabled: false },
      recordingsDir,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ok = await fireWebhookForRecording("audio_ready", makeRow());
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when webhook.url is blank", async () => {
    updateConfig({
      webhook: { url: "", enabled: true },
      recordingsDir,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ok = await fireWebhookForRecording("audio_ready", makeRow());
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fireWebhookForRecording — payload construction", () => {
  beforeEach(() => {
    resetConfigCache();
    resetDbSingleton();
    getDb();
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
    });
    getDb().prepare("DELETE FROM webhook_log").run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("audio_ready: POSTs the expected payload shape (no content block) and records a webhook_log row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireWebhookForRecording("audio_ready", makeRow());
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hook.example/ingest");
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)["x-rootscribe-event"],
    ).toBe("audio_ready");

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.event).toBe("audio_ready");
    expect(body.recording).toMatchObject({ id: "rec-abc", filename: "standup.ogg" });
    expect(body.http_urls).toMatchObject({
      audio: "http://127.0.0.1:44471/media/2026-04-11_standup__abc/audio.ogg",
    });
    // No content block on audio_ready events.
    expect(body.content).toBeUndefined();

    expect(countWebhookLogRows()).toBe(1);
  });

  it("rewrites bind.host '0.0.0.0' to '127.0.0.1' in http_urls so the webhook receiver can reach back", async () => {
    updateConfig({ bind: { host: "0.0.0.0", port: 9999 } });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhookForRecording("audio_ready", makeRow({ folder: "f" }));
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body.http_urls.audio).toBe("http://127.0.0.1:9999/media/f/audio.ogg");
  });

  it("URL-encodes each segment of folder paths in http_urls (preserves '/' but escapes reserved chars)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhookForRecording(
      "audio_ready",
      makeRow({ folder: "year 2026/q two/My Meeting #42" }),
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    );
    // '/' separators stay, spaces become %20, '#' becomes %23
    expect(body.http_urls.audio).toContain(
      "/media/year%202026/q%20two/My%20Meeting%20%2342/audio.ogg",
    );
    // files.folder stays unencoded (raw path for consumers reading off disk).
    expect(body.files.folder).toBe("year 2026/q two/My Meeting #42");
  });

  it("transcript_ready: attaches a content block with inline transcript_text + summary_markdown when files exist", async () => {
    const folder = "2026-04-11_standup__abc";
    const folderAbs = path.join(recordingsDir, folder);
    mkdirSync(folderAbs, { recursive: true });
    writeFileSync(
      path.join(folderAbs, "transcript.txt"),
      "[00:01] Alice: hello",
    );
    writeFileSync(path.join(folderAbs, "summary.md"), "## Key point\nhi");

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhookForRecording("transcript_ready", makeRow({ folder }));
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body.event).toBe("transcript_ready");
    expect(body.content).toEqual({
      transcript_text: "[00:01] Alice: hello",
      summary_markdown: "## Key point\nhi",
    });
  });

  it("transcript_ready with missing files on disk: content fields are null (not an error)", async () => {
    const folder = "2026-04-11_missing__xyz";
    // Don't create the folder — the readIfExists path should handle it.

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireWebhookForRecording(
      "transcript_ready",
      makeRow({ folder }),
    );
    expect(ok).toBe(true);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body.content).toEqual({
      transcript_text: null,
      summary_markdown: null,
    });
  });

  it("transcript_ready: files that exist but throw on read → content field is null (readIfExists catch)", async () => {
    // The empty string as `readFileSync` return masks the readIfExists catch
    // path, since existsSync is true but readFileSync succeeds. To exercise
    // the inner catch, create the files but make readFileSync throw by
    // pointing at a path that exists-as-a-directory (readFileSync EISDIR).
    const folder = "2026-04-11_eisdir__xyz";
    const folderAbs = path.join(recordingsDir, folder);
    mkdirSync(folderAbs, { recursive: true });
    // Create transcript.txt and summary.md AS DIRECTORIES so existsSync
    // returns true (buildPayload's first check) but readFileSync throws
    // EISDIR — which the catch block must swallow. Content fields should
    // still come back null.
    mkdirSync(path.join(folderAbs, "transcript.txt"), { recursive: true });
    mkdirSync(path.join(folderAbs, "summary.md"), { recursive: true });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireWebhookForRecording(
      "transcript_ready",
      makeRow({ folder }),
    );
    expect(ok).toBe(true);
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body.content).toEqual({
      transcript_text: null,
      summary_markdown: null,
    });
  });
});

describe("fireWebhookForRecording — retry + backoff", () => {
  beforeEach(() => {
    resetConfigCache();
    resetDbSingleton();
    getDb();
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
    });
    getDb().prepare("DELETE FROM webhook_log").run();
    // Fake only setTimeout/setInterval — better-sqlite3 needs real Date.now
    // for its internal timers, and the `started = Date.now()` / "fired_at"
    // calculations in post.ts rely on real wall-clock time advancing.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns true on the first success (no retries, 1 log row)", async () => {
    // Use 200 + empty body rather than 204 — `new Response("", { status: 204 })`
    // throws because a 204 must have a null body (undici enforces this).
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireWebhookForRecording("audio_ready", makeRow());
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(countWebhookLogRows()).toBe(1);
  });

  it("retries with 5s/30s backoff on network errors until it succeeds on attempt 3", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fireWebhookForRecording("audio_ready", makeRow());
    // Attempt 1 → reject. Backoff 5s.
    await vi.advanceTimersByTimeAsync(5_000);
    // Attempt 2 → reject. Backoff 30s.
    await vi.advanceTimersByTimeAsync(30_000);
    // Attempt 3 → success.
    const ok = await pending;

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Three rows in the log: two errors + one success.
    expect(countWebhookLogRows()).toBe(3);
    const rows = getDb()
      .prepare<
        [],
        { status_code: number | null; error: string | null }
      >(
        "SELECT status_code, error FROM webhook_log ORDER BY id ASC",
      )
      .all();
    expect(rows[0]!.error).toContain("connection reset");
    expect(rows[1]!.error).toContain("connection reset");
    expect(rows[2]!.status_code).toBe(200);
    expect(rows[2]!.error).toBeNull();
  });

  it("retries on non-2xx HTTP responses and gives up after 3 failed attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("server boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fireWebhookForRecording("audio_ready", makeRow());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const ok = await pending;

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(countWebhookLogRows()).toBe(3);
    const errors = getDb()
      .prepare<[], { error: string | null }>(
        "SELECT error FROM webhook_log ORDER BY id ASC",
      )
      .all();
    for (const row of errors) expect(row.error).toBe("HTTP 500");
  });

  it("gives up after 3 network errors and returns false (no further retries)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("DNS failure"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fireWebhookForRecording("audio_ready", makeRow());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const ok = await pending;

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("testWebhook — single-shot (no retries)", () => {
  beforeEach(() => {
    resetConfigCache();
    updateConfig({
      webhook: { url: "https://hook.example", enabled: true },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns ok=true + statusCode + bodySnippet on 2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("pong", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await testWebhook("https://hook.example");
    expect(res.ok).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.bodySnippet).toBe("pong");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.error).toBeUndefined();
  });

  it("returns ok=false + statusCode on non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not authorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await testWebhook("https://hook.example");
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.bodySnippet).toBe("not authorized");
  });

  it("returns ok=false + error on fetch throw (no retries)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await testWebhook("https://nope.example");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ENOTFOUND");
    expect(res.statusCode).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a test payload with a stable `test: true` marker + x-rootscribe-test: 1 header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testWebhook("https://hook.example");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-rootscribe-test"]).toBe(
      "1",
    );
    const body = JSON.parse(String(init.body)) as { test: boolean; event: string };
    expect(body.test).toBe(true);
    expect(body.event).toBe("transcript_ready");
  });

  it("trims the 500-char bodySnippet limit on large responses", async () => {
    const big = "x".repeat(2000);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(big, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await testWebhook("https://hook.example");
    expect(res.bodySnippet?.length).toBe(500);
  });
});

// Parse `t=<sec>,v1=<hex>` into its parts. Kept strict on purpose: a receiver
// that splits on "," then "=" is the documented recipe, so any drift in the
// serialization shows up here first.
function parseSignature(header: string): { t: number; v1: string } {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) throw new Error(`unexpected signature header shape: ${header}`);
  return { t: Number(match[1]), v1: match[2]! };
}

function expectedSignature(secret: string, t: number, body: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

describe("fireWebhookForRecording — signing + instance headers", () => {
  const secret = "whsec_unit_test_secret";

  beforeEach(() => {
    resetConfigCache();
    resetDbSingleton();
    getDb();
    getDb().prepare("DELETE FROM webhook_log").run();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("signed delivery: carries x-rootscribe-signature (t + v1) whose v1 verifies against the sent body with the secret", async () => {
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true, secret },
      recordingsDir,
      instanceId: "inst-signed",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const before = Math.floor(Date.now() / 1000);
    await fireWebhookForRecording("transcript_ready", makeRow());
    const after = Math.floor(Date.now() / 1000);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const { t, v1 } = parseSignature(headers["x-rootscribe-signature"]!);

    // Timestamp header mirrors the `t=` component and is "now" in seconds.
    expect(headers["x-rootscribe-timestamp"]).toBe(String(t));
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
    // v1 is the HMAC over `${t}.${exact body bytes sent}`.
    expect(v1).toBe(expectedSignature(secret, t, String(init.body)));
  });

  it("always sends x-rootscribe-instance from config.instanceId", async () => {
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true, secret },
      recordingsDir,
      instanceId: "inst-abc-123",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhookForRecording("audio_ready", makeRow());
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-rootscribe-instance"]).toBe("inst-abc-123");
  });

  it("no secret configured: sends the instance header and NO signature / timestamp headers", async () => {
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true },
      recordingsDir,
      instanceId: "inst-unsigned",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhookForRecording("audio_ready", makeRow());
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-rootscribe-instance"]).toBe("inst-unsigned");
    expect(headers).not.toHaveProperty("x-rootscribe-signature");
    expect(headers).not.toHaveProperty("x-rootscribe-timestamp");
  });

  it("mints and persists an instance id on the fly when settings.json has none, so the header is never missing", async () => {
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true },
      recordingsDir,
      instanceId: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fireWebhookForRecording("audio_ready", makeRow());
    await fireWebhookForRecording("audio_ready", makeRow());
    const first = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const second = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(first["x-rootscribe-instance"]).toMatch(/^[0-9a-f-]{36}$/);
    // Stable across deliveries — persisted, not re-minted per call.
    expect(second["x-rootscribe-instance"]).toBe(first["x-rootscribe-instance"]);
    resetConfigCache();
    expect(loadConfig().instanceId).toBe(first["x-rootscribe-instance"]);
  });

  it("a hand-edited non-string secret in settings.json does not throw — delivery goes out unsigned", async () => {
    // Copilot review on PR #19 round 3: loadConfig() trusts the file's
    // shape, so `"secret": 12345` would reach createHmac(), throw, and make
    // fireRaw retry the same broken delivery forever. A non-string is
    // treated as "no secret" rather than taking down every webhook.
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true, secret: 12345 as unknown as string },
      recordingsDir,
      instanceId: "inst-badsecret",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireWebhookForRecording("audio_ready", makeRow());
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-rootscribe-instance"]).toBe("inst-badsecret");
    expect(headers).not.toHaveProperty("x-rootscribe-signature");
  });

  it("captures the secret once per delivery so a rotation mid-backoff does not break the retry", async () => {
    // Copilot review on PR #19 round 4: re-reading the secret on every
    // attempt means a 503 followed by a secret rotation in Settings would
    // sign the retry with the NEW key, which the original receiver rejects —
    // a transient failure becomes a permanent one. The timestamp/signature
    // are still recomputed per attempt, just with the captured key.
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true, secret },
      recordingsDir,
      instanceId: "inst-rotate",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fireWebhookForRecording("audio_ready", makeRow());
    // Attempt 1 has fired (503) and the 5s backoff is armed. Rotate now.
    await vi.advanceTimersByTimeAsync(0);
    updateConfig({ webhook: { url: "https://hook.example/ingest", enabled: true, secret: "rotated" } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      const { t, v1 } = parseSignature((init.headers as Record<string, string>)["x-rootscribe-signature"]!);
      expect(v1).toBe(expectedSignature(secret, t, String(init.body)));
    }
  });

  it("each retry attempt carries a FRESH timestamp and signature (headers are not computed once before the loop)", async () => {
    // Copilot review on PR #19 round 19 (suppressed finding): with Date
    // real and only timers faked, every attempt could share one second and
    // a headers-computed-once regression would still pass. Fake Date too
    // so the 5s / 30s backoff is visible in `t`.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true, secret },
      recordingsDir,
      instanceId: "inst-fresh",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fireWebhookForRecording("audio_ready", makeRow());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(true);

    const stamps = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const { t, v1 } = parseSignature(headers["x-rootscribe-signature"]!);
      expect(headers["x-rootscribe-timestamp"]).toBe(String(t));
      expect(v1).toBe(expectedSignature(secret, t, String(init.body)));
      return { t, v1 };
    });
    expect(stamps).toHaveLength(3);
    expect(stamps[1]!.t - stamps[0]!.t).toBe(5);
    expect(stamps[2]!.t - stamps[1]!.t).toBe(30);
    expect(new Set(stamps.map((s) => s.v1)).size).toBe(3);
  });

  it("re-signs every retry attempt so a delivery after backoff still verifies", async () => {
    updateConfig({
      webhook: { url: "https://hook.example/ingest", enabled: true, secret },
      recordingsDir,
      instanceId: "inst-retry",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = fireWebhookForRecording("audio_ready", makeRow());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const { t, v1 } = parseSignature(headers["x-rootscribe-signature"]!);
      expect(v1).toBe(expectedSignature(secret, t, String(init.body)));
    }
  });
});

describe("testWebhook — signing + instance headers", () => {
  const secret = "whsec_test_delivery";

  beforeEach(() => {
    resetConfigCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is signed the same way as a real delivery when a secret is configured", async () => {
    updateConfig({
      webhook: { url: "https://hook.example", enabled: true, secret },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
      instanceId: "inst-test-delivery",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testWebhook("https://hook.example");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const { t, v1 } = parseSignature(headers["x-rootscribe-signature"]!);
    expect(headers["x-rootscribe-timestamp"]).toBe(String(t));
    expect(v1).toBe(expectedSignature(secret, t, String(init.body)));
    expect(headers["x-rootscribe-instance"]).toBe("inst-test-delivery");
    // The existing test marker is still there alongside the signature.
    expect(headers["x-rootscribe-test"]).toBe("1");
  });

  it("without a secret: instance header only, no signature", async () => {
    updateConfig({
      webhook: { url: "https://hook.example", enabled: true },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
      instanceId: "inst-test-unsigned",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testWebhook("https://hook.example");
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-rootscribe-instance"]).toBe("inst-test-unsigned");
    expect(headers).not.toHaveProperty("x-rootscribe-signature");
    expect(headers).not.toHaveProperty("x-rootscribe-timestamp");
  });

  // Copilot review on PR #19: the Settings/wizard secret lives in form state
  // until Save, so a Test click must be able to sign with the DRAFT value —
  // otherwise it silently uses the old (or no) secret and "succeeds" against
  // a receiver that could never verify the value the user is about to save.
  it("signs with an explicitly supplied draft secret instead of the persisted one", async () => {
    updateConfig({
      webhook: { url: "https://hook.example", enabled: true, secret: "persisted-secret" },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
      instanceId: "inst-draft",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testWebhook("https://hook.example", "draft-secret");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const { t, v1 } = parseSignature(headers["x-rootscribe-signature"]!);
    expect(v1).toBe(expectedSignature("draft-secret", t, String(init.body)));
    expect(v1).not.toBe(expectedSignature("persisted-secret", t, String(init.body)));
  });

  it("stamps a caller-supplied draft instance id so Test matches what Save will send", async () => {
    // Copilot review on PR #19 round 9: Settings lets the user edit the
    // instance id, but Test used the persisted one — a passing test could
    // describe different headers than the saved configuration.
    updateConfig({
      webhook: { url: "https://hook.example", enabled: true, secret },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
      instanceId: "inst-persisted",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testWebhook("https://hook.example", undefined, "inst-draft");
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-rootscribe-instance"]).toBe("inst-draft");
    // The persisted value is untouched — this is a per-request override.
    expect(loadConfig().instanceId).toBe("inst-persisted");
  });

  it("an explicitly empty draft secret sends an unsigned test even when one is persisted", async () => {
    updateConfig({
      webhook: { url: "https://hook.example", enabled: true, secret: "persisted-secret" },
      recordingsDir,
      bind: { host: "127.0.0.1", port: 44471 },
      instanceId: "inst-cleared",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testWebhook("https://hook.example", "");
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty("x-rootscribe-signature");
    expect(headers["x-rootscribe-instance"]).toBe("inst-cleared");
  });
});
