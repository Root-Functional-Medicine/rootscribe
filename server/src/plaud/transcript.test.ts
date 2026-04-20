import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import type { ContentListItem } from "./detail.js";
import type { TranssummResponse, TranscriptSegment } from "./transcript.js";

// Mock client so getTranscriptAndSummary can be tested without a real
// network call. We use vi.hoisted so the mock can capture calls before
// the transcript module (which imports client) resolves.
const plaudJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  plaudJson: plaudJsonMock,
}));

const {
  extractSummaryMarkdown,
  flattenTranscript,
  getTranscriptAndSummary,
  fetchTranscriptFromContentList,
} = await import("./transcript.js");

function resp(dataResultSumm: TranssummResponse["data_result_summ"]): TranssummResponse {
  return {
    status: 0,
    msg: "ok",
    data_result: null,
    data_result_summ: dataResultSumm,
    data_result_summ_mul: null,
    outline_result: null,
  };
}

describe("extractSummaryMarkdown", () => {
  it("returns null when the field is missing", () => {
    expect(extractSummaryMarkdown(resp(null))).toBeNull();
  });

  it("returns the raw string unchanged when it is not valid JSON", () => {
    expect(extractSummaryMarkdown(resp("# Plain markdown\n\nHello"))).toBe(
      "# Plain markdown\n\nHello",
    );
  });

  it("returns null when the JSON payload parses to `null` (not an object)", () => {
    // Regression guard: JSON.parse("null") returns the value null, which would
    // crash `.content` access if we didn't shape-check the parsed result.
    expect(extractSummaryMarkdown(resp("null"))).toBeNull();
  });

  it("returns null when the JSON payload parses to a primitive (not an object)", () => {
    expect(extractSummaryMarkdown(resp("42"))).toBeNull();
    expect(extractSummaryMarkdown(resp('"bare string"'))).toBeNull();
  });

  it("extracts content when the JSON envelope nests it as a plain string", () => {
    const json = JSON.stringify({ content: "## Summary\n\nBody" });
    expect(extractSummaryMarkdown(resp(json))).toBe("## Summary\n\nBody");
  });

  it("extracts content.markdown when the JSON envelope nests it as an object", () => {
    const json = JSON.stringify({
      content: { markdown: "- point one\n- point two", other: "ignored" },
    });
    expect(extractSummaryMarkdown(resp(json))).toBe("- point one\n- point two");
  });

  it("accepts an already-parsed object (the short-recording path)", () => {
    const summ = { content: { markdown: "short summary" } };
    expect(extractSummaryMarkdown(resp(summ))).toBe("short summary");
  });

  it("returns null when the parsed content is a whitespace-only string", () => {
    const json = JSON.stringify({ content: "   \n\t  " });
    expect(extractSummaryMarkdown(resp(json))).toBeNull();
  });

  it("returns null when content.markdown is present but whitespace-only", () => {
    const json = JSON.stringify({ content: { markdown: "   " } });
    expect(extractSummaryMarkdown(resp(json))).toBeNull();
  });

  it("returns null when the raw string is empty", () => {
    expect(extractSummaryMarkdown(resp(""))).toBeNull();
  });
});

// ---------- flattenTranscript ----------

describe("flattenTranscript", () => {
  function seg(
    overrides: Partial<TranscriptSegment> = {},
  ): TranscriptSegment {
    return {
      start_time: 0,
      end_time: 1000,
      content: "hello",
      speaker: "Alice",
      original_speaker: "Alice",
      ...overrides,
    };
  }

  it("returns an empty string for null / empty input", () => {
    expect(flattenTranscript(null)).toBe("");
    expect(flattenTranscript([])).toBe("");
  });

  it("formats each segment as [mm:ss] speaker: content, joined with blank lines", () => {
    const out = flattenTranscript([
      seg({ start_time: 5_000, speaker: "Alice", content: "hello" }),
      seg({ start_time: 65_000, speaker: "Bob", content: "hi back" }),
    ]);
    expect(out).toBe("[00:05] Alice: hello\n\n[01:05] Bob: hi back");
  });

  it("formats timestamps as h:mm:ss when start_time crosses an hour", () => {
    const out = flattenTranscript([
      seg({ start_time: 3_725_000, speaker: "A", content: "late" }),
    ]);
    expect(out).toBe("[1:02:05] A: late");
  });

  it("falls back to original_speaker when speaker is empty", () => {
    const out = flattenTranscript([
      seg({ speaker: "", original_speaker: "FromOriginal", content: "x" }),
    ]);
    expect(out).toContain("FromOriginal:");
  });

  it("uses 'Speaker' as a last-resort fallback when both fields are empty", () => {
    const out = flattenTranscript([
      seg({ speaker: "", original_speaker: "", content: "x" }),
    ]);
    expect(out).toContain("Speaker:");
  });
});

// ---------- getTranscriptAndSummary ----------

describe("getTranscriptAndSummary", () => {
  beforeEach(() => {
    plaudJsonMock.mockReset();
  });

  it("POSTs to /ai/transsumm/<id> with an empty JSON body and returns the parsed response", async () => {
    const fixture: TranssummResponse = {
      status: 0,
      msg: "ok",
      data_result: [],
      data_result_summ: null,
      data_result_summ_mul: null,
      outline_result: null,
    };
    plaudJsonMock.mockResolvedValue(fixture);

    const out = await getTranscriptAndSummary("rec-42");
    expect(out).toBe(fixture);
    expect(plaudJsonMock).toHaveBeenCalledWith("/ai/transsumm/rec-42", {
      method: "POST",
      body: "{}",
    });
  });
});

// ---------- fetchTranscriptFromContentList ----------

describe("fetchTranscriptFromContentList", () => {
  const transcriptSegs: TranscriptSegment[] = [
    {
      start_time: 0,
      end_time: 1000,
      content: "hi",
      speaker: "A",
      original_speaker: "A",
    },
    {
      start_time: 2000,
      end_time: 3000,
      content: "hi back",
      speaker: "B",
      original_speaker: "B",
    },
  ];
  const transcriptJson = JSON.stringify(transcriptSegs);
  const summaryMd = "## Summary\n\nHello";

  afterEach(() => vi.unstubAllGlobals());

  function item(
    type: string,
    link: string | null,
  ): ContentListItem {
    return { data_type: type, data_link: link ?? "" } as ContentListItem;
  }

  it("returns empty segments + null summary when the content list has no matching items", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([]);
    expect(r.segments).toEqual([]);
    expect(r.summaryMd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads + gunzips a gzipped transcript link", async () => {
    const gz = gzipSync(Buffer.from(transcriptJson));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(gz, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([
      item("transaction", "https://s3.example/t.json.gz"),
    ]);
    expect(r.segments).toEqual(transcriptSegs);
    expect(r.summaryMd).toBeNull();
  });

  it("downloads a plain (non-gzipped) transcript link", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(transcriptJson, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([
      item("transaction", "https://s3.example/t.json"),
    ]);
    expect(r.segments).toEqual(transcriptSegs);
  });

  it("converts a segments-as-object payload via Object.values() (older recordings shape)", async () => {
    // Plaud stored some older transcripts as { "0": segA, "1": segB } rather
    // than a plain array. The fallback extractor uses Object.values().
    const objPayload = JSON.stringify({ "0": transcriptSegs[0], "1": transcriptSegs[1] });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(objPayload, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([
      item("transaction", "https://s3.example/t.json"),
    ]);
    expect(r.segments).toEqual(transcriptSegs);
  });

  it("skips transcript download when the S3 response is non-2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([
      item("transaction", "https://s3.example/t.json"),
    ]);
    expect(r.segments).toEqual([]);
  });

  it("downloads + extracts a summary markdown link (gzipped)", async () => {
    // Two fetches: transcript (404 → skipped) + summary (200, gzipped).
    const gzSummary = gzipSync(Buffer.from(summaryMd));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(gzSummary, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([
      item("transaction", "https://s3.example/t.json"),
      item("auto_sum_note", "https://s3.example/s.md.gz"),
    ]);
    expect(r.summaryMd).toBe(summaryMd);
  });

  it("downloads a plain (non-gzipped) summary markdown", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(summaryMd, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([
      item("transaction", "https://s3.example/t.json"),
      item("auto_sum_note", "https://s3.example/s.md"),
    ]);
    expect(r.summaryMd).toBe(summaryMd);
  });

  it("returns null summaryMd when the downloaded summary is only whitespace", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("   \n\n   ", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchTranscriptFromContentList([
      item("transaction", "https://s3.example/t.json"),
      item("auto_sum_note", "https://s3.example/s.md"),
    ]);
    expect(r.summaryMd).toBeNull();
  });
});
