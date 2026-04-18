import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ApiError, api } from "./api.js";

// Typed shim for the fetch mock — keeps per-test setup ergonomic without
// leaning on `any`. Vitest 2.x takes the full function signature as one
// generic argument instead of (Args, Return) pairs.
type FetchMock = Mock<typeof fetch>;

function jsonResponse(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": init.contentType ?? "application/json" },
  });
}

describe("ApiError", () => {
  it("carries an HTTP status alongside the message", () => {
    const err = new ApiError("bad request", 400);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("bad request");
    expect(err.status).toBe(400);
  });
});

describe("jsonFetch error extraction (via api.config)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws ApiError with parsed message on 400 responses", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "token required" }, { status: 400 }),
    );

    await expect(api.config()).rejects.toMatchObject({
      status: 400,
      message: "token required",
    });
  });

  it("flattens Zod validation errors into a semicolon-joined string", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            formErrors: [],
            fieldErrors: {
              pollIntervalMinutes: ["Expected number", "Number must be >= 1"],
              recordingsDir: ["String must contain at least 1 character(s)"],
            },
          },
        },
        { status: 400 },
      ),
    );

    await expect(api.config()).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/pollIntervalMinutes:.*recordingsDir:/s),
    });
  });

  it("surfaces the raw body when the response isn't JSON", async () => {
    // jsonFetch prefers the raw body text for non-JSON responses, and only
    // falls back to "HTTP <status>" when the body is also empty. This test
    // covers the common "upstream returned plain-text error" path.
    fetchMock.mockResolvedValueOnce(
      new Response("not json at all", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(api.config()).rejects.toMatchObject({
      status: 500,
      message: "not json at all",
    });
  });

  it("falls back to 'HTTP <status>' only when the error body is empty", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("", {
        status: 502,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(api.config()).rejects.toMatchObject({
      status: 502,
      message: "HTTP 502",
    });
  });

  it("handles nested message/error keys (e.g. { error: { message: '...' } })", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: "validation failed" } }, { status: 422 }),
    );

    await expect(api.config()).rejects.toMatchObject({
      status: 422,
      message: "validation failed",
    });
  });

  it("returns parsed JSON on successful responses", async () => {
    const body = { config: { setupComplete: true } };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const result = await api.config();
    expect(result).toEqual(body);
  });
});

describe("api.listRecordings query string", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
    // Must return a FRESH Response each call — Response bodies are single-use,
    // so reusing one via mockResolvedValue breaks the second call with
    // InvalidStateError.
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ recordings: [], total: 0 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits all query parameters when none are provided", async () => {
    await api.listRecordings();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/recordings?");
  });

  it("encodes limit, offset, and filter when provided", async () => {
    await api.listRecordings({ limit: 25, offset: 50, filter: "active" });
    const [url] = fetchMock.mock.calls[0] as [string];
    const qs = new URLSearchParams(url.split("?")[1] ?? "");
    expect(qs.get("limit")).toBe("25");
    expect(qs.get("offset")).toBe("50");
    expect(qs.get("filter")).toBe("active");
  });

  it("URL-encodes search terms with spaces and special characters", async () => {
    await api.listRecordings({ search: "a b&c=d" });
    const [url] = fetchMock.mock.calls[0] as [string];
    const qs = new URLSearchParams(url.split("?")[1] ?? "");
    expect(qs.get("search")).toBe("a b&c=d");
  });

  it("sends facets=1 only when facets is truthy", async () => {
    await api.listRecordings({ facets: true });
    const [url1] = fetchMock.mock.calls[0] as [string];
    expect(new URLSearchParams(url1.split("?")[1] ?? "").get("facets")).toBe("1");

    await api.listRecordings({ facets: false });
    const [url2] = fetchMock.mock.calls[1] as [string];
    expect(new URLSearchParams(url2.split("?")[1] ?? "").get("facets")).toBeNull();
  });
});

describe("api.setInboxStatus", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ recording: {}, availableTags: [], availableCategories: [] }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits `notes` from the body when not provided for a 'new' transition", async () => {
    await api.setInboxStatus("rec-1", "new");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ status: "new" });
  });

  it("includes `notes` when set on a 'reviewed' transition", async () => {
    await api.setInboxStatus("rec-1", "reviewed", "looked good");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      status: "reviewed",
      notes: "looked good",
    });
  });
});

describe("api.removeTag / removeJiraLink", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ recording: {}, availableTags: [], availableCategories: [] }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("URL-encodes tag names with special characters", async () => {
    await api.removeTag("rec-1", "foo/bar");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/recordings/rec-1/tags/foo%2Fbar");
  });

  it("URL-encodes Jira issue keys with special characters", async () => {
    await api.removeJiraLink("rec-1", "DEVX-1 (sub)");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/recordings/rec-1/jira-links/DEVX-1%20(sub)");
  });
});
