import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaudRawRecording, RecordingRow } from "@rootscribe/shared";

// ---------- Mocks ----------
// Mock every upstream the poller touches. `loadConfig` stays controllable
// per test via a small state object; `PlaudAuthError` must be a real class
// (the poller uses `instanceof` to branch auth vs generic errors).

const configState: {
  current: {
    token: string | null;
    recordingsDir: string | null;
    setupComplete: boolean;
    pollIntervalMinutes: number;
  };
} = {
  current: {
    token: null,
    recordingsDir: null,
    setupComplete: false,
    pollIntervalMinutes: 10,
  },
};

vi.mock("../config.js", () => ({
  loadConfig: () => configState.current,
}));

vi.mock("../plaud/list.js", () => ({
  listRecordings: vi.fn(),
}));
vi.mock("../plaud/audio.js", () => ({
  downloadAudio: vi.fn(),
}));
vi.mock("../plaud/transcript.js", () => ({
  getTranscriptAndSummary: vi.fn(),
  flattenTranscript: vi.fn(() => "[00:01] Alice: hello\n"),
  extractSummaryMarkdown: vi.fn(() => "## Summary\nhello"),
  fetchTranscriptFromContentList: vi.fn(),
}));
vi.mock("../plaud/detail.js", () => ({
  getFileDetail: vi.fn(),
}));
vi.mock("../plaud/client.js", () => {
  class PlaudAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PlaudAuthError";
    }
  }
  return { PlaudAuthError };
});
vi.mock("./state.js", () => ({
  upsertFromPlaud: vi.fn(),
  markAudioDownloaded: vi.fn(),
  markTranscriptDownloaded: vi.fn(),
  markWebhookFired: vi.fn(),
  recordError: vi.fn(),
  getRecordingById: vi.fn(),
  findPendingTranscriptIds: vi.fn(() => []),
}));
vi.mock("./layout.js", () => ({
  ensureRecordingFolder: vi.fn(() => ({
    audioPath: "/t/audio.ogg",
    transcriptJsonPath: "/t/transcript.json",
    transcriptTxtPath: "/t/transcript.txt",
    summaryMdPath: "/t/summary.md",
    metadataPath: "/t/metadata.json",
  })),
}));
vi.mock("../webhook/post.js", () => ({
  fireWebhookForRecording: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./events.js", () => ({
  emit: vi.fn(),
}));
// writeFileSync shouldn't actually touch the disk during these tests.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, writeFileSync: vi.fn() };
});

const { poller } = await import("./poller.js");
const { listRecordings } = await import("../plaud/list.js");
const { downloadAudio } = await import("../plaud/audio.js");
const { getTranscriptAndSummary, fetchTranscriptFromContentList } = await import(
  "../plaud/transcript.js"
);
const { getFileDetail } = await import("../plaud/detail.js");
const { PlaudAuthError } = await import("../plaud/client.js");
const {
  upsertFromPlaud,
  markAudioDownloaded,
  markTranscriptDownloaded,
  markWebhookFired,
  recordError,
  getRecordingById,
  findPendingTranscriptIds,
} = await import("./state.js");
const { fireWebhookForRecording } = await import("../webhook/post.js");
const { emit } = await import("./events.js");

// ---------- Fixture helpers ----------

function makePlaudItem(id: string, overrides: Partial<PlaudRawRecording> = {}): PlaudRawRecording {
  return {
    id,
    filename: `${id}.ogg`,
    start_time: 1_700_000_000,
    end_time: 1_700_000_060,
    filesize: 1024,
    sn: "SN1",
    is_trash: 0,
    is_historical: 0,
    is_trans: false,
    trans_status: 0,
    duration: 60,
    ...overrides,
  } as PlaudRawRecording;
}

function makeRow(id: string, overrides: Partial<RecordingRow> = {}): RecordingRow {
  return {
    id,
    filename: `${id}.ogg`,
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_060_000,
    durationMs: 60_000,
    filesizeBytes: 1024,
    serialNumber: "SN1",
    folder: `2026-04-11_${id}__${id}`,
    audioPath: "audio.ogg",
    transcriptPath: null,
    summaryPath: null,
    metadataPath: null,
    audioDownloadedAt: null,
    transcriptDownloadedAt: null,
    webhookAudioFiredAt: null,
    webhookTranscriptFiredAt: null,
    isTrash: false,
    isHistorical: false,
    lastError: null,
    status: "pending_audio",
    inboxStatus: "new",
    effectiveInboxStatus: "new",
    category: null,
    snoozedUntil: null,
    reviewedAt: null,
    tags: [],
    ...overrides,
  };
}

type PlaudListResponse = Awaited<ReturnType<typeof listRecordings>>;

function plaudPage(items: PlaudRawRecording[], total = items.length): PlaudListResponse {
  return {
    status: 0,
    msg: "ok",
    data_file_total: total,
    data_file_list: items,
  } as unknown as PlaudListResponse;
}

// ---------- Reset helpers ----------

function resetPoller(): void {
  poller.stop();
  poller.lastPollAt = null;
  poller.nextPollAt = null;
  poller.lastError = null;
  poller.authRequired = false;
}

function setConfig(
  overrides: Partial<typeof configState.current> = {},
): void {
  configState.current = {
    token: "tok",
    recordingsDir: "/recs",
    setupComplete: true,
    pollIntervalMinutes: 10,
    ...overrides,
  };
}

beforeEach(() => {
  resetPoller();
  setConfig();
  vi.mocked(listRecordings).mockReset();
  vi.mocked(downloadAudio).mockReset().mockResolvedValue(1024);
  vi.mocked(getTranscriptAndSummary).mockReset();
  vi.mocked(fetchTranscriptFromContentList).mockReset();
  vi.mocked(getFileDetail).mockReset().mockResolvedValue({
    content_list: [],
  } as unknown as Awaited<ReturnType<typeof getFileDetail>>);
  vi.mocked(upsertFromPlaud).mockReset();
  vi.mocked(markAudioDownloaded).mockReset();
  vi.mocked(markTranscriptDownloaded).mockReset();
  vi.mocked(markWebhookFired).mockReset();
  vi.mocked(recordError).mockReset();
  vi.mocked(getRecordingById).mockReset();
  vi.mocked(findPendingTranscriptIds).mockReset().mockReturnValue([]);
  vi.mocked(fireWebhookForRecording).mockReset().mockResolvedValue(true);
  vi.mocked(emit).mockReset();
});

afterEach(() => {
  resetPoller();
});

// ---------- Lifecycle ----------

describe("poller.start / stop / status", () => {
  it("status() reflects initial state (null lastPollAt, no error, not polling)", () => {
    const s = poller.status();
    expect(s).toEqual({
      lastPollAt: null,
      nextPollAt: null,
      polling: false,
      lastError: null,
      authRequired: false,
    });
  });

  it("start() skips polling when token is missing (pollAndProcess no-ops early)", async () => {
    setConfig({ token: null });
    vi.mocked(listRecordings).mockResolvedValue(plaudPage([]));

    poller.start();
    // Let the immediate `void this.runOnce()` microtask settle.
    await new Promise((r) => setImmediate(r));
    expect(vi.mocked(listRecordings)).not.toHaveBeenCalled();
    poller.stop();
  });

  it("start() calls listRecordings right away (doesn't wait the full interval)", async () => {
    vi.mocked(listRecordings).mockResolvedValue(plaudPage([]));
    poller.start();
    await new Promise((r) => setImmediate(r));
    expect(vi.mocked(listRecordings)).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent — a second call is a no-op while the interval is live", async () => {
    vi.mocked(listRecordings).mockResolvedValue(plaudPage([]));
    poller.start();
    await new Promise((r) => setImmediate(r));
    const callsAfterFirst = vi.mocked(listRecordings).mock.calls.length;
    poller.start();
    await new Promise((r) => setImmediate(r));
    expect(vi.mocked(listRecordings).mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("poller.trigger — queueing", () => {
  it("awaits a fresh run when not already polling", async () => {
    vi.mocked(listRecordings).mockResolvedValue(plaudPage([]));
    await poller.trigger();
    expect(vi.mocked(listRecordings)).toHaveBeenCalledTimes(1);
    expect(poller.lastPollAt).not.toBeNull();
  });

  it("queues a re-run when a poll is already in flight, then runs it after the first finishes", async () => {
    // Make the first listRecordings hang so we can observe the queued state.
    let resolveFirst: (v: PlaudListResponse) => void = () => undefined;
    vi.mocked(listRecordings).mockImplementationOnce(
      () =>
        new Promise<PlaudListResponse>((r) => {
          resolveFirst = r;
        }),
    );
    // Subsequent calls resolve immediately with an empty page.
    vi.mocked(listRecordings).mockResolvedValue(plaudPage([]));

    const first = poller.trigger();
    // The first runOnce has set inFlight=true by the time we await the
    // first microtask; the second trigger should queue.
    await new Promise((r) => setImmediate(r));
    const second = poller.trigger();

    // Release the first call's listRecordings.
    resolveFirst(plaudPage([]));
    await first;
    await second;

    // Two runs fired: the original + the queued replay.
    expect(vi.mocked(listRecordings).mock.calls.length).toBe(2);
  });
});

// ---------- pollAndProcess ----------

describe("poller.pollAndProcess — pagination", () => {
  it("walks pages until a page returns fewer than 50 items, then stops", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makePlaudItem(`a${i}`));
    const shortPage = [makePlaudItem("last")];
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage(fullPage, 120))
      .mockResolvedValueOnce(plaudPage(fullPage, 120))
      .mockResolvedValueOnce(plaudPage(shortPage, 120));
    vi.mocked(upsertFromPlaud).mockImplementation((item) =>
      makeRow(item.id),
    );

    await poller.trigger();
    expect(vi.mocked(listRecordings)).toHaveBeenCalledTimes(3);
    // 50 + 50 + 1 = 101 ingests.
    expect(vi.mocked(upsertFromPlaud)).toHaveBeenCalledTimes(101);
  });

  it("stops immediately when the first page is empty", async () => {
    vi.mocked(listRecordings).mockResolvedValueOnce(plaudPage([]));
    await poller.trigger();
    expect(vi.mocked(listRecordings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertFromPlaud)).not.toHaveBeenCalled();
  });

  it("throws when Plaud returns a non-zero status (wrapped as lastError via runOnce)", async () => {
    vi.mocked(listRecordings).mockResolvedValueOnce({
      status: 401,
      msg: "unauthorized",
      data_file_total: 0,
      data_file_list: [],
    } as unknown as Awaited<ReturnType<typeof listRecordings>>);

    await poller.trigger();
    expect(poller.lastError).toContain("status=401");
    expect(poller.authRequired).toBe(false);
  });
});

// ---------- Error classification ----------

describe("poller.runOnce — error classification", () => {
  it("pauses polling with authRequired=true when Plaud returns PlaudAuthError", async () => {
    vi.mocked(listRecordings).mockRejectedValueOnce(
      new PlaudAuthError("token expired"),
    );

    await poller.trigger();
    expect(poller.authRequired).toBe(true);
    expect(poller.lastError).toBe("token expired");
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      "auth_required",
      expect.objectContaining({ message: "token expired" }),
    );
  });

  it("captures generic errors as lastError and emits 'error'", async () => {
    vi.mocked(listRecordings).mockRejectedValueOnce(
      new Error("network down"),
    );

    await poller.trigger();
    expect(poller.authRequired).toBe(false);
    expect(poller.lastError).toBe("network down");
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ message: "network down" }),
    );
  });

  it("resets authRequired to false on a successful poll", async () => {
    poller.authRequired = true;
    vi.mocked(listRecordings).mockResolvedValue(plaudPage([]));
    await poller.trigger();
    expect(poller.authRequired).toBe(false);
    expect(poller.lastError).toBeNull();
  });
});

// ---------- ingestOne ----------

describe("poller.ingestOne — new recording flow", () => {
  it("downloads audio, marks it, then fires audio_ready webhook on a brand-new recording", async () => {
    const item = makePlaudItem("new-1");
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(
      makeRow("new-1", { audioDownloadedAt: null }),
    );
    vi.mocked(downloadAudio).mockResolvedValue(2048);
    vi.mocked(getRecordingById).mockReturnValue(
      makeRow("new-1", { audioDownloadedAt: Date.now() }),
    );

    await poller.trigger();
    expect(vi.mocked(downloadAudio)).toHaveBeenCalledWith(
      "new-1",
      "/t/audio.ogg",
    );
    expect(vi.mocked(markAudioDownloaded)).toHaveBeenCalledWith("new-1", 2048);
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      "recording_new",
      expect.objectContaining({ recordingId: "new-1" }),
    );
    expect(vi.mocked(fireWebhookForRecording)).toHaveBeenCalledWith(
      "audio_ready",
      expect.objectContaining({ id: "new-1" }),
    );
    expect(vi.mocked(markWebhookFired)).toHaveBeenCalledWith(
      "new-1",
      "audio_ready",
    );
  });

  it("skips audio download when audioDownloadedAt is already set", async () => {
    const item = makePlaudItem("existing");
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(
      makeRow("existing", { audioDownloadedAt: 12345 }),
    );

    await poller.trigger();
    expect(vi.mocked(downloadAudio)).not.toHaveBeenCalled();
  });

  it("does NOT mark webhook fired when the webhook itself returns false", async () => {
    const item = makePlaudItem("no-webhook");
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(
      makeRow("no-webhook", { audioDownloadedAt: null }),
    );
    vi.mocked(getRecordingById).mockReturnValue(makeRow("no-webhook"));
    vi.mocked(fireWebhookForRecording).mockResolvedValue(false);

    await poller.trigger();
    expect(vi.mocked(markWebhookFired)).not.toHaveBeenCalled();
  });

  it("continues when getFileDetail throws (logged, non-fatal)", async () => {
    const item = makePlaudItem("file-detail-fail");
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(
      makeRow("file-detail-fail", { audioDownloadedAt: null }),
    );
    vi.mocked(getFileDetail).mockRejectedValueOnce(new Error("500"));
    vi.mocked(getRecordingById).mockReturnValue(makeRow("file-detail-fail"));

    await poller.trigger();
    // Audio still downloaded despite metadata fetch failure.
    expect(vi.mocked(downloadAudio)).toHaveBeenCalled();
    expect(poller.lastError).toBeNull();
  });

  it("per-item errors are isolated: one failing ingest doesn't abort the poll", async () => {
    const items = [makePlaudItem("a"), makePlaudItem("b")];
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage(items))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud)
      .mockImplementationOnce(() => {
        throw new Error("item a upsert failed");
      })
      .mockImplementationOnce((item) => makeRow(item.id));

    await poller.trigger();
    // Second item's upsert still ran.
    expect(vi.mocked(upsertFromPlaud)).toHaveBeenCalledTimes(2);
    // First item's error was recorded + emitted.
    expect(vi.mocked(recordError)).toHaveBeenCalledWith(
      "a",
      "item a upsert failed",
    );
    // Overall poll succeeded (per-item errors are swallowed).
    expect(poller.lastError).toBeNull();
  });
});

// ---------- tryTranscript ----------

describe("poller.tryTranscript — flow", () => {
  it("writes transcript.json + transcript.txt + summary.md on a transsumm success, then fires transcript_ready webhook", async () => {
    const item = makePlaudItem("t1", { is_trans: true });
    const row = makeRow("t1", {
      audioDownloadedAt: Date.now(),
      transcriptDownloadedAt: null,
    });
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(row);
    vi.mocked(getRecordingById).mockReturnValue(row);
    vi.mocked(getTranscriptAndSummary).mockResolvedValue({
      data_result: [
        { start: 0, end: 1, text: "hi", speaker: "A" },
      ],
    } as unknown as Awaited<ReturnType<typeof getTranscriptAndSummary>>);

    await poller.trigger();
    expect(vi.mocked(markTranscriptDownloaded)).toHaveBeenCalledWith(
      "t1",
      "[00:01] Alice: hello\n",
    );
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      "recording_downloaded",
      expect.objectContaining({ recordingId: "t1" }),
    );
    expect(vi.mocked(fireWebhookForRecording)).toHaveBeenCalledWith(
      "transcript_ready",
      expect.objectContaining({ id: "t1" }),
    );
  });

  it("falls back to the S3/content_list flow when transsumm returns an empty data_result", async () => {
    const item = makePlaudItem("t2", { is_trans: true });
    const row = makeRow("t2", { audioDownloadedAt: Date.now() });
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(row);
    vi.mocked(getRecordingById).mockReturnValue(row);
    vi.mocked(getTranscriptAndSummary).mockResolvedValue({
      data_result: [],
    } as unknown as Awaited<ReturnType<typeof getTranscriptAndSummary>>);
    vi.mocked(getFileDetail).mockResolvedValue({
      content_list: [{ path: "s3://stuff", type: "transcript" }],
    } as unknown as Awaited<ReturnType<typeof getFileDetail>>);
    vi.mocked(fetchTranscriptFromContentList).mockResolvedValue({
      segments: [{ start: 0, end: 1, text: "hi", speaker: "A" }],
      summaryMd: "## Summary\nfrom S3",
    } as unknown as Awaited<ReturnType<typeof fetchTranscriptFromContentList>>);

    await poller.trigger();
    expect(vi.mocked(fetchTranscriptFromContentList)).toHaveBeenCalled();
    expect(vi.mocked(markTranscriptDownloaded)).toHaveBeenCalledWith(
      "t2",
      "[00:01] Alice: hello\n",
    );
  });

  it("no-ops when content_list is empty in the fallback path", async () => {
    const item = makePlaudItem("t3", { is_trans: true });
    const row = makeRow("t3", { audioDownloadedAt: Date.now() });
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(row);
    vi.mocked(getRecordingById).mockReturnValue(row);
    vi.mocked(getTranscriptAndSummary).mockResolvedValue({
      data_result: [],
    } as unknown as Awaited<ReturnType<typeof getTranscriptAndSummary>>);
    vi.mocked(getFileDetail).mockResolvedValue({
      content_list: [],
    } as unknown as Awaited<ReturnType<typeof getFileDetail>>);

    await poller.trigger();
    expect(vi.mocked(markTranscriptDownloaded)).not.toHaveBeenCalled();
  });

  it("retries transcripts for pending IDs that weren't in the current page", async () => {
    // No items in the current page, but one pending transcript from a
    // previous poll that should retry.
    vi.mocked(listRecordings).mockResolvedValueOnce(plaudPage([]));
    vi.mocked(findPendingTranscriptIds).mockReturnValue(["pending-1"]);
    const row = makeRow("pending-1", { audioDownloadedAt: Date.now() });
    vi.mocked(getRecordingById).mockReturnValue(row);
    vi.mocked(getTranscriptAndSummary).mockResolvedValue({
      data_result: [{ start: 0, end: 1, text: "hi", speaker: "A" }],
    } as unknown as Awaited<ReturnType<typeof getTranscriptAndSummary>>);

    await poller.trigger();
    expect(vi.mocked(markTranscriptDownloaded)).toHaveBeenCalledWith(
      "pending-1",
      "[00:01] Alice: hello\n",
    );
  });

  it("skips pending retry for IDs already in the current page (already handled above)", async () => {
    const item = makePlaudItem("both", { is_trans: false });
    vi.mocked(listRecordings)
      .mockResolvedValueOnce(plaudPage([item]))
      .mockResolvedValue(plaudPage([]));
    vi.mocked(upsertFromPlaud).mockReturnValue(
      makeRow("both", { audioDownloadedAt: null }),
    );
    vi.mocked(findPendingTranscriptIds).mockReturnValue(["both"]);
    vi.mocked(getRecordingById).mockReturnValue(makeRow("both"));

    await poller.trigger();
    // getTranscriptAndSummary is NOT called for the pending retry because
    // "both" is in the current page (pending retry short-circuits).
    expect(vi.mocked(getTranscriptAndSummary)).not.toHaveBeenCalled();
  });
});
