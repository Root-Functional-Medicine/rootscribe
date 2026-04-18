import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaudListResponse, PlaudRawRecording } from "@rootscribe/shared";

// Stub the low-level HTTP helper so these tests cover list.ts's query-param
// logic in isolation. The plaudJson → plaudFetch → fetch stack is exercised
// separately via the client's own tests.
const plaudJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  plaudJson: plaudJsonMock,
}));

const { listRecordings, listAll } = await import("./list.js");

function makeRecording(overrides: Partial<PlaudRawRecording> = {}): PlaudRawRecording {
  // Mirror the full PlaudRawRecording shape so a downstream consumer
  // accessing any documented field doesn't trip on a partial mock.
  return {
    id: "r1",
    filename: "recording",
    fullname: "2026-04-18 recording.ogg",
    filesize: 12345,
    file_md5: "deadbeef",
    start_time: 1_775_000_000_000,
    end_time: 1_775_000_060_000,
    duration: 60,
    version: 1,
    version_ms: 1_775_000_000_000,
    edit_time: 1_775_000_060_000,
    is_trash: false,
    is_trans: true,
    is_summary: true,
    serial_number: "SN-001",
    ...overrides,
  };
}

function makeResponse(
  items: PlaudRawRecording[],
  total = items.length,
): PlaudListResponse {
  return {
    status: 0,
    msg: "ok",
    request_id: "req-1",
    data_file_total: total,
    data_file_list: items,
  };
}

function lastRequestedPath(): string {
  const call = plaudJsonMock.mock.calls.at(-1);
  if (!call) throw new Error("plaudJson was not called");
  return call[0] as string;
}

function lastRequestedQuery(): URLSearchParams {
  const url = lastRequestedPath();
  const idx = url.indexOf("?");
  if (idx < 0) throw new Error(`URL has no query string: ${url}`);
  return new URLSearchParams(url.slice(idx + 1));
}

describe("listRecordings", () => {
  beforeEach(() => {
    plaudJsonMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hits /file/simple/web", async () => {
    plaudJsonMock.mockResolvedValueOnce(makeResponse([]));
    await listRecordings();

    expect(lastRequestedPath().startsWith("/file/simple/web?")).toBe(true);
  });

  it("uses documented defaults when no options are passed", async () => {
    plaudJsonMock.mockResolvedValueOnce(makeResponse([]));
    await listRecordings();

    const q = lastRequestedQuery();
    expect(q.get("skip")).toBe("0");
    expect(q.get("limit")).toBe("50");
    expect(q.get("sort_by")).toBe("start_time");
    expect(q.get("is_desc")).toBe("true");
    // is_trash=2 is Plaud's "not-in-trash" filter — documented in the API.
    expect(q.get("is_trash")).toBe("2");
  });

  it("forwards caller-supplied skip and limit as strings", async () => {
    plaudJsonMock.mockResolvedValueOnce(makeResponse([]));
    await listRecordings({ skip: 150, limit: 25 });

    const q = lastRequestedQuery();
    expect(q.get("skip")).toBe("150");
    expect(q.get("limit")).toBe("25");
  });

  it("switches sort column when sortBy=edit_time", async () => {
    plaudJsonMock.mockResolvedValueOnce(makeResponse([]));
    await listRecordings({ sortBy: "edit_time" });

    expect(lastRequestedQuery().get("sort_by")).toBe("edit_time");
  });

  it("serializes isDesc=false as the literal string 'false'", async () => {
    // Plaud's API treats the query string value literally — if we sent the
    // bare value Boolean(false) it would render as an empty string. This
    // guards against a future refactor replacing String(b) with b.toString()
    // or similar that happens to match today but could regress.
    plaudJsonMock.mockResolvedValueOnce(makeResponse([]));
    await listRecordings({ isDesc: false });

    expect(lastRequestedQuery().get("is_desc")).toBe("false");
  });

  it("allows caller to request trashed recordings by setting isTrash=1", async () => {
    plaudJsonMock.mockResolvedValueOnce(makeResponse([]));
    await listRecordings({ isTrash: 1 });

    expect(lastRequestedQuery().get("is_trash")).toBe("1");
  });

  it("returns the response body verbatim", async () => {
    const response = makeResponse([makeRecording({ id: "abc" })]);
    plaudJsonMock.mockResolvedValueOnce(response);

    const got = await listRecordings();
    expect(got).toBe(response);
  });
});

describe("listAll", () => {
  beforeEach(() => {
    plaudJsonMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty array when the first page is empty", async () => {
    plaudJsonMock.mockResolvedValueOnce(makeResponse([]));

    expect(await listAll()).toEqual([]);
  });

  it("stops after the first page when it has fewer items than the page size", async () => {
    const page = [makeRecording({ id: "a" }), makeRecording({ id: "b" })];
    plaudJsonMock.mockResolvedValueOnce(makeResponse(page, 2));

    const got = await listAll(10); // pageSize=10, got 2 → last page
    expect(got).toHaveLength(2);
    expect(plaudJsonMock).toHaveBeenCalledTimes(1);
  });

  it("paginates through multiple full pages until a short page is returned", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) =>
      makeRecording({ id: `p1-${i}` }),
    );
    const page2 = Array.from({ length: 3 }, (_, i) =>
      makeRecording({ id: `p2-${i}` }),
    );
    const page3 = [makeRecording({ id: "p3-0" })];

    plaudJsonMock
      .mockResolvedValueOnce(makeResponse(page1))
      .mockResolvedValueOnce(makeResponse(page2))
      .mockResolvedValueOnce(makeResponse(page3));

    const got = await listAll(3);
    expect(got.map((r) => r.id)).toEqual([
      "p1-0",
      "p1-1",
      "p1-2",
      "p2-0",
      "p2-1",
      "p2-2",
      "p3-0",
    ]);
    expect(plaudJsonMock).toHaveBeenCalledTimes(3);
  });

  it("advances the skip cursor by pageSize between calls", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) =>
      makeRecording({ id: `p1-${i}` }),
    );
    const page2 = Array.from({ length: 2 }, (_, i) =>
      makeRecording({ id: `p2-${i}` }),
    );
    plaudJsonMock
      .mockResolvedValueOnce(makeResponse(page1))
      .mockResolvedValueOnce(makeResponse(page2))
      .mockResolvedValueOnce(makeResponse([]));

    await listAll(2);

    const queries = plaudJsonMock.mock.calls.map(
      (call) => new URLSearchParams((call[0] as string).split("?")[1]),
    );
    expect(queries.map((q) => q.get("skip"))).toEqual(["0", "2", "4"]);
  });

  it("hard-caps at 200 iterations to avoid infinite loops on a misbehaving API", async () => {
    // Always return a full page so the short-page early-exit never fires.
    plaudJsonMock.mockImplementation(async () =>
      makeResponse(
        Array.from({ length: 5 }, (_, i) => makeRecording({ id: `x-${i}` })),
      ),
    );

    const got = await listAll(5);
    expect(plaudJsonMock).toHaveBeenCalledTimes(200);
    expect(got).toHaveLength(200 * 5);
  });

  it("treats a nullish data_file_list as end-of-stream (defensive break)", async () => {
    // Plaud has been observed returning { data_file_list: null } on edge
    // cases — list.ts guards against this with the `!page.data_file_list`
    // check. Without it, the subsequent `.length` would throw.
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      msg: "ok",
      data_file_total: 0,
      data_file_list: null,
    } as unknown as PlaudListResponse);

    expect(await listAll()).toEqual([]);
  });
});
