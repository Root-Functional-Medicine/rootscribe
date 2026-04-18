import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";

// Stub the heavy dependencies so routes/sync.ts's surface can be tested in
// isolation. poller/syncEvents are both module-level singletons; state.ts
// touches the real DB. We're pinning route-level orchestration here — the
// underlying modules get their own coverage from direct tests.
const pollerMock = vi.hoisted(() => ({
  status: vi.fn(),
  trigger: vi.fn(),
}));
const syncEventsMock = vi.hoisted(() => ({
  onEvent: vi.fn(),
}));
const stateMock = vi.hoisted(() => ({
  countPendingTranscripts: vi.fn(),
  countErrorsLast24h: vi.fn(),
}));

vi.mock("../../src/sync/poller.js", () => ({ poller: pollerMock }));
vi.mock("../../src/sync/events.js", () => ({ syncEvents: syncEventsMock }));
vi.mock("../../src/sync/state.js", () => stateMock);

const { syncRouter } = await import("../../src/routes/sync.js");
const { makeTestApp } = await import("../helpers/test-server.js");

describe("GET /api/sync/status", () => {
  beforeEach(() => {
    pollerMock.status.mockReset();
    pollerMock.trigger.mockReset();
    stateMock.countPendingTranscripts.mockReset();
    stateMock.countErrorsLast24h.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("composes the response from poller.status() + state counters", async () => {
    pollerMock.status.mockReturnValue({
      lastPollAt: 1_700_000_000_000,
      nextPollAt: 1_700_000_600_000,
      polling: false,
      lastError: null,
      authRequired: false,
    });
    stateMock.countPendingTranscripts.mockReturnValue(3);
    stateMock.countErrorsLast24h.mockReturnValue(1);

    const app = makeTestApp((a) => a.use("/api/sync", syncRouter));
    const res = await request(app).get("/api/sync/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      lastPollAt: 1_700_000_000_000,
      nextPollAt: 1_700_000_600_000,
      polling: false,
      pendingTranscripts: 3,
      errorsLast24h: 1,
      lastError: null,
      authRequired: false,
    });
  });

  it("surfaces authRequired=true when the poller reports it", async () => {
    // Regression guard: authRequired is how the UI knows to redirect to the
    // setup wizard after a token expires. Silently dropping it would leave
    // users stuck staring at an empty dashboard.
    pollerMock.status.mockReturnValue({
      lastPollAt: null,
      nextPollAt: null,
      polling: false,
      lastError: "401 unauthorized",
      authRequired: true,
    });
    stateMock.countPendingTranscripts.mockReturnValue(0);
    stateMock.countErrorsLast24h.mockReturnValue(5);

    const app = makeTestApp((a) => a.use("/api/sync", syncRouter));
    const res = await request(app).get("/api/sync/status");

    expect(res.status).toBe(200);
    expect(res.body.authRequired).toBe(true);
    expect(res.body.lastError).toBe("401 unauthorized");
  });
});

describe("POST /api/sync/trigger", () => {
  beforeEach(() => {
    pollerMock.trigger.mockReset();
  });

  it("awaits poller.trigger() and returns { ok: true } on success", async () => {
    pollerMock.trigger.mockResolvedValueOnce(undefined);

    const app = makeTestApp((a) => a.use("/api/sync", syncRouter));
    const res = await request(app).post("/api/sync/trigger");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(pollerMock.trigger).toHaveBeenCalledTimes(1);
  });

  it("propagates poller.trigger() errors as 500 (Express default handler)", async () => {
    pollerMock.trigger.mockRejectedValueOnce(new Error("plaud down"));

    const app = makeTestApp((a) => a.use("/api/sync", syncRouter));
    // Silence Express's default console error for the duration of this test.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(app).post("/api/sync/trigger");
    consoleSpy.mockRestore();

    expect(res.status).toBe(500);
  });
});

describe("GET /api/sync/events (SSE)", () => {
  let server: Server;
  let baseUrl: string;
  let unsub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    unsub = vi.fn();
    syncEventsMock.onEvent.mockReset().mockReturnValue(unsub);
  });

  afterEach(() => {
    return new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  // Boot a real server so the SSE response actually streams. supertest keeps
  // the connection open via its http Agent, which is exactly what we want to
  // assert on Content-Type + initial data frame.
  async function boot(): Promise<void> {
    const app = makeTestApp((a) => a.use("/api/sync", syncRouter));
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  it("sets text/event-stream headers and emits a 'subscribed' frame on open", async () => {
    await boot();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/sync/events`, {
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    expect(text).toContain('"type":"subscribed"');

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("registers a syncEvents listener on connect and unsubscribes on client close", async () => {
    await boot();
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/sync/events`, { signal: controller.signal });
    // Consume the first frame so express writes the response.
    const reader = res.body!.getReader();
    await reader.read();

    expect(syncEventsMock.onEvent).toHaveBeenCalledTimes(1);

    // Abort the client — Express fires 'close' on the req, which should
    // call our unsub() and tear down the heartbeat interval.
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Give the server a microtask to fire its 'close' handler.
    await new Promise((r) => setTimeout(r, 50));
    expect(unsub).toHaveBeenCalled();
  });
});
