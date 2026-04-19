import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RecordingRow } from "@rootscribe/shared";
import { cleanupTempDir, mkTempConfigDir } from "../helpers/test-server.js";

// Capture the caller's ROOTSCRIBE_CONFIG_DIR so afterAll can restore it.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;

// Set the env var BEFORE importing any server module so the config + db
// singletons latch onto the disposable temp directory for this suite only.
const configDir = mkTempConfigDir("rootscribe-webhook-post-");

const { fireWebhookForRecording, testWebhook } = await import(
  "../../src/webhook/post.js"
);
const { resetConfigCache, updateConfig } = await import(
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

function makeRow(overrides: Partial<RecordingRow> = {}): RecordingRow {
  return {
    id: "rec-abc",
    filename: "standup.ogg",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_060_000,
    durationMs: 60_000,
    filesizeBytes: 1024,
    serialNumber: "SN1",
    folder: "2026-04-11_standup__abc",
    audioPath: "audio.ogg",
    transcriptPath: null,
    summaryPath: null,
    metadataPath: null,
    audioDownloadedAt: Date.now(),
    transcriptDownloadedAt: null,
    webhookAudioFiredAt: null,
    webhookTranscriptFiredAt: null,
    isTrash: false,
    isHistorical: false,
    lastError: null,
    status: "complete",
    inboxStatus: "new",
    effectiveInboxStatus: "new",
    category: null,
    snoozedUntil: null,
    reviewedAt: null,
    tags: [],
    ...overrides,
  };
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
