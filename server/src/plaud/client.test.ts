import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock loadConfig / updateConfig so each test can stage token + region
// without touching real files. The client reads config via each helper
// individually, so the state object is fine for per-test control.
const configState: {
  token: string | null;
  plaudRegion: string | null;
  setupComplete: boolean;
} = {
  token: null,
  plaudRegion: null,
  setupComplete: true,
};
const updateConfigMock = vi.fn((patch: Partial<typeof configState>) => {
  Object.assign(configState, patch);
  return configState;
});

vi.mock("../config.js", () => ({
  loadConfig: () => configState,
  updateConfig: updateConfigMock,
}));

const { getPlaudApiBase, PlaudAuthError, PlaudApiError, plaudFetch, plaudJson } =
  await import("./client.js");

beforeEach(() => {
  configState.token = "test-token";
  configState.plaudRegion = null;
  configState.setupComplete = true;
  updateConfigMock.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getPlaudApiBase", () => {
  it("returns the default when no region is configured", () => {
    configState.plaudRegion = null;
    expect(getPlaudApiBase()).toBe("https://api.plaud.ai");
  });

  it("returns the region-specific base for aws:eu-central-1", () => {
    configState.plaudRegion = "aws:eu-central-1";
    expect(getPlaudApiBase()).toBe("https://api-euc1.plaud.ai");
  });

  it("returns the default for aws:us-west-2 (happens to match the default URL)", () => {
    configState.plaudRegion = "aws:us-west-2";
    expect(getPlaudApiBase()).toBe("https://api.plaud.ai");
  });

  it("falls back to the default when the region isn't in the region map", () => {
    configState.plaudRegion = "aws:ap-south-1";
    expect(getPlaudApiBase()).toBe("https://api.plaud.ai");
  });
});

describe("PlaudAuthError + PlaudApiError", () => {
  it("PlaudAuthError carries the message + a recognizable name", () => {
    const err = new PlaudAuthError("expired");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlaudAuthError");
    expect(err.message).toBe("expired");
  });

  it("PlaudApiError carries message + status + body", () => {
    const err = new PlaudApiError("boom", 500, "body snippet");
    expect(err.name).toBe("PlaudApiError");
    expect(err.status).toBe(500);
    expect(err.body).toBe("body snippet");
  });
});

describe("plaudFetch — URL + headers", () => {
  it("accepts an absolute URL verbatim", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await plaudFetch("https://custom.example/foo");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.example/foo");
  });

  it("prepends the API base for relative paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await plaudFetch("/file/simple/web");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.plaud.ai/file/simple/web");
  });

  it("uses the regional API base when plaudRegion is set", async () => {
    configState.plaudRegion = "aws:eu-central-1";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await plaudFetch("/file/simple/web");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-euc1.plaud.ai/file/simple/web");
  });

  it("sends Authorization + User-Agent + Accept headers on every request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await plaudFetch("/x");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers.accept).toBe("application/json");
    expect(headers["user-agent"]).toContain("rootscribe/");
  });

  it("uses authOverride over the configured token when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await plaudFetch("/x", { authOverride: "override-token" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer override-token");
  });

  it("adds content-type: application/json when a body is present and no content-type was set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await plaudFetch("/x", { method: "POST", body: "{}" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("does NOT override an explicit content-type header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await plaudFetch("/x", {
      method: "POST",
      body: "raw",
      headers: { "content-type": "text/plain" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("text/plain");
  });

  it("throws PlaudAuthError when there is no configured token and no override", async () => {
    configState.token = null;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(plaudFetch("/x")).rejects.toBeInstanceOf(PlaudAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("plaudFetch — 401 handling + retry + backoff", () => {
  it("throws PlaudAuthError on HTTP 401 and updates setupComplete to trigger re-auth UI", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(plaudFetch("/x")).rejects.toBeInstanceOf(PlaudAuthError);
    // updateConfig({ setupComplete: true }) flags that setup ran, forcing
    // the client to re-detect a fresh token on the next boot.
    expect(updateConfigMock).toHaveBeenCalledWith({ setupComplete: true });
  });

  it("retries on 5xx with 1s/2s backoff, up to 3 attempts total", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = plaudFetch("/x");
    // First retry after 1000ms.
    await vi.advanceTimersByTimeAsync(1_000);
    // Second retry after 2000ms.
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns the last 5xx response after exhausting attempts (does NOT throw)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = plaudFetch("/x");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries network errors and eventually succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = plaudFetch("/x");
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws PlaudApiError with network error context after exhausting network retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("DNS failure"));
    vi.stubGlobal("fetch", fetchMock);

    // Capture the rejection via .catch() so Vitest doesn't flag an
    // unhandled rejection between fake-timer advances. Assert on the
    // captured error after all retries complete.
    let caught: unknown;
    const pending = plaudFetch("/x").catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(caught).toBeInstanceOf(PlaudApiError);
  });

  it("propagates a PlaudAuthError thrown mid-retry without retrying further", async () => {
    // First call: 401 → PlaudAuthError. Should not retry.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(plaudFetch("/x")).rejects.toBeInstanceOf(PlaudAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("plaudJson", () => {
  it("parses a JSON body on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ foo: "bar", n: 42 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const r = await plaudJson<{ foo: string; n: number }>("/x");
    expect(r).toEqual({ foo: "bar", n: 42 });
  });

  it("throws PlaudApiError with the status + 500-char snippet on non-2xx responses", async () => {
    const big = "x".repeat(2_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(big, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    // Exhaust the retry budget first — plaudFetch still returns the 503.
    // Attach a .catch() that captures the error so the rejection doesn't
    // surface as an unhandled error between fake-timer advances. Assert
    // on the captured error after all retries complete.
    let caught: unknown;
    const pending = plaudJson<unknown>("/x", { method: "POST" }).catch((e) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(caught).toBeInstanceOf(PlaudApiError);
    const apiErr = caught as InstanceType<typeof PlaudApiError>;
    expect(apiErr.status).toBe(503);
    expect(apiErr.body.length).toBe(500);
    expect(apiErr.message).toContain("POST /x → 503");
  });

  it("throws PlaudApiError when the body is 2xx but not valid JSON", async () => {
    // Fresh Response per call — Response bodies are single-use, so a shared
    // mockResolvedValue instance would fail on the second plaudJson call.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("not json at all", { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(plaudJson("/x")).rejects.toThrowError(PlaudApiError);
    await expect(plaudJson("/x")).rejects.toThrowError(/non-JSON/);
  });

  it("uses the method + path in the error message for non-2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("error body", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(plaudJson("/missing")).rejects.toThrowError(
      /GET \/missing → 404/,
    );
  });
});
