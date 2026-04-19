import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import type { WatchEvent, Listener } from "../../src/auth/browser-watch.js";
import { cleanupTempDir, makeTestApp, mkTempConfigDir } from "../helpers/test-server.js";

// Capture + reset ROOTSCRIBE_CONFIG_DIR so this suite's disposable temp
// directory doesn't leak into the user's real config.
const originalConfigDir = process.env.ROOTSCRIBE_CONFIG_DIR;
const configDir = mkTempConfigDir("rootscribe-routes-auth-");

// Mocks for the three upstream modules the route handlers call into. Must
// be declared BEFORE the router import so vi.mock hoists their factories
// ahead of the real module resolution.
vi.mock("../../src/auth/chrome-leveldb.js", () => ({
  findToken: vi.fn(),
}));
vi.mock("../../src/auth/browser-watch.js", () => ({
  startBrowserWatch: vi.fn(),
  subscribeWatch: vi.fn(),
}));
vi.mock("../../src/plaud/client.js", async () => {
  class PlaudAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PlaudAuthError";
    }
  }
  return {
    plaudFetch: vi.fn(),
    PlaudAuthError,
  };
});

const { authRouter } = await import("../../src/routes/auth.js");
const { resetConfigCache, loadConfig, updateConfig } = await import(
  "../../src/config.js"
);
const { resetDbSingleton } = await import("../../src/db.js");
const { findToken } = await import("../../src/auth/chrome-leveldb.js");
const { startBrowserWatch, subscribeWatch } = await import(
  "../../src/auth/browser-watch.js"
);
const { plaudFetch, PlaudAuthError } = await import(
  "../../src/plaud/client.js"
);

const app = makeTestApp((a) => a.use("/api/auth", authRouter));

// JWT fixture with recognizable payload fields — `eyJ...` triple-segment
// format that extractJwt's regex matches, plus a base64-encoded payload
// that parseJwt can decode to produce real email/exp/iat/region values.
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwiZXhwIjoyMDAwMDAwMDAwLCJpYXQiOjE5MDAwMDAwMDAsInJlZ2lvbiI6InVzLWVhc3QifQ" +
  ".sigXYZ123";

const EXP_FROM_JWT = 2_000_000_000;

afterAll(() => {
  resetConfigCache();
  resetDbSingleton();
  cleanupTempDir(configDir);
  if (originalConfigDir == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
  else process.env.ROOTSCRIBE_CONFIG_DIR = originalConfigDir;
});

beforeEach(() => {
  resetConfigCache();
  resetDbSingleton();
  // updateConfig() persists to disk, so in-memory resetConfigCache alone
  // isn't enough to isolate tests — one test's saved token re-appears on
  // the next loadConfig() call. Explicitly blank out the token-related
  // fields each time so tests that assert "not persisted" see a clean slate.
  updateConfig({
    token: null,
    tokenExp: null,
    tokenEmail: null,
    plaudRegion: null,
  });
  vi.mocked(findToken).mockReset();
  vi.mocked(startBrowserWatch).mockReset();
  vi.mocked(subscribeWatch).mockReset();
  vi.mocked(plaudFetch).mockReset();
});

describe("POST /api/auth/detect", () => {
  it("returns {found: false} when findToken resolves to null", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    const res = await request(app).post("/api/auth/detect").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false });
  });

  it("returns {found: true, token, browser, profile, email} when findToken hits", async () => {
    vi.mocked(findToken).mockResolvedValue({
      token: JWT,
      browser: "Chrome",
      profile: "Default",
      email: "alice@example.com",
      iat: 1_900_000_000,
      exp: EXP_FROM_JWT,
    });
    const res = await request(app).post("/api/auth/detect").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      found: true,
      token: JWT,
      browser: "Chrome",
      profile: "Default",
      email: "alice@example.com",
    });
  });

  it("returns 500 with {found:false, error} when findToken throws", async () => {
    vi.mocked(findToken).mockRejectedValue(new Error("leveldb open failed"));
    const res = await request(app).post("/api/auth/detect").send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ found: false, error: "leveldb open failed" });
  });
});

describe("POST /api/auth/accept", () => {
  afterEach(() => {
    vi.mocked(plaudFetch).mockReset();
  });

  it("400 on missing/short token", async () => {
    const res = await request(app).post("/api/auth/accept").send({ token: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid body");
  });

  it("400 when the payload has no JWT-shaped string in it", async () => {
    const res = await request(app)
      .post("/api/auth/accept")
      .send({ token: "not-a-jwt-just-some-long-string-at-all" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no JWT");
  });

  it("stores token + region + email + exp when validation succeeds", async () => {
    vi.mocked(plaudFetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await request(app)
      .post("/api/auth/accept")
      .send({ token: JWT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      email: "alice@example.com",
      exp: EXP_FROM_JWT,
    });
    const cfg = loadConfig();
    expect(cfg.token).toBe(JWT);
    expect(cfg.tokenEmail).toBe("alice@example.com");
    expect(cfg.tokenExp).toBe(EXP_FROM_JWT);
    expect(cfg.plaudRegion).toBe("us-east");
  });

  it("prefers explicitly-passed email over the JWT's own email claim", async () => {
    vi.mocked(plaudFetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await request(app)
      .post("/api/auth/accept")
      .send({ token: JWT, email: "override@example.com" });

    expect(res.body.email).toBe("override@example.com");
    expect(loadConfig().tokenEmail).toBe("override@example.com");
  });

  it("returns 400 + ok:false when Plaud returns HTTP 401 during validation", async () => {
    vi.mocked(plaudFetch).mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );

    const res = await request(app)
      .post("/api/auth/accept")
      .send({ token: JWT });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("HTTP 401");
    // Config token is NOT persisted on validation failure.
    expect(loadConfig().token).not.toBe(JWT);
  });

  it("returns 400 + ok:false when Plaud returns non-zero status field", async () => {
    vi.mocked(plaudFetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 401, msg: "token expired" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await request(app)
      .post("/api/auth/accept")
      .send({ token: JWT });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("msg=token expired");
  });

  it("returns 400 + ok:false with the PlaudAuthError message when plaudFetch throws that", async () => {
    vi.mocked(plaudFetch).mockRejectedValue(new PlaudAuthError("expired"));

    const res = await request(app)
      .post("/api/auth/accept")
      .send({ token: JWT });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("expired");
  });
});

describe("POST /api/auth/validate", () => {
  it("returns ok:true + exp without persisting the token", async () => {
    vi.mocked(plaudFetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const before = loadConfig().token;
    const res = await request(app)
      .post("/api/auth/validate")
      .send({ token: JWT });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.exp).toBe(EXP_FROM_JWT);
    // Unlike /accept, /validate must NOT mutate config.
    expect(loadConfig().token).toBe(before);
  });

  it("returns 400 on short body", async () => {
    const res = await request(app).post("/api/auth/validate").send({ token: "x" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("returns 200 with ok:false when the body is long enough but contains no JWT", async () => {
    const res = await request(app)
      .post("/api/auth/validate")
      .send({ token: "this-is-longer-than-ten-chars-but-no-jwt" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain("no JWT");
  });
});

describe("POST /api/auth/watch", () => {
  it("returns the watchId produced by startBrowserWatch", async () => {
    vi.mocked(startBrowserWatch).mockResolvedValue("watch-42");
    const res = await request(app).post("/api/auth/watch").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ watchId: "watch-42" });
    expect(vi.mocked(startBrowserWatch)).toHaveBeenCalledWith(true);
  });

  it("returns 500 with error when startBrowserWatch rejects", async () => {
    vi.mocked(startBrowserWatch).mockRejectedValue(new Error("no browser"));
    const res = await request(app).post("/api/auth/watch").send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("no browser");
  });
});

describe("GET /api/auth/watch/:id/events (SSE)", () => {
  // SSE streams never end normally, so supertest's one-shot request model
  // hangs waiting for an `end` event that will never come. Follow the same
  // pattern as server/tests/routes/sync.test.ts: boot a real HTTP server
  // and consume the chunked response via native fetch + AbortController.
  let server: Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (!server) return;
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function boot(): Promise<void> {
    const bootApp = makeTestApp((a) => a.use("/api/auth", authRouter));
    await new Promise<void>((resolve) => {
      server = bootApp.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address();
    if (typeof addr === "string" || addr === null) {
      throw new Error("no address");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  function parseDataFrames(raw: string): unknown[] {
    return raw
      .split("\n\n")
      .map((block) => block.trim())
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice("data: ".length)) as unknown);
  }

  // Read SSE frames from a Response body until `predicate(raw)` is true.
  // Throws on deadline hit or premature stream end so a slow CI runner
  // fails with a clear "timed out waiting for X" message instead of a
  // confusing "missing frame" assertion further down.
  async function readUntil(
    res: Response,
    predicate: (acc: string) => boolean,
  ): Promise<string> {
    const timeoutMs = 2000;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        if (predicate(raw)) return raw;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(
            `readUntil: timed out after ${timeoutMs}ms. Received: ${JSON.stringify(raw)}`,
          );
        }
        const read = await Promise.race([
          reader.read(),
          new Promise<{ value: Uint8Array | undefined; done: boolean }>(
            (_, reject) => {
              setTimeout(() => {
                reject(
                  new Error(
                    `readUntil: timed out after ${timeoutMs}ms. Received: ${JSON.stringify(raw)}`,
                  ),
                );
              }, remainingMs);
            },
          ),
        ]);
        if (read.value) raw += decoder.decode(read.value, { stream: true });
        if (predicate(raw)) return raw;
        if (read.done) {
          throw new Error(
            `readUntil: stream ended before predicate matched. Received: ${JSON.stringify(raw)}`,
          );
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  it("emits {type:'subscribed'} immediately and forwards subsequent events from subscribeWatch", async () => {
    // Capture the listener so the test can push events into it once the
    // route has registered it with subscribeWatch.
    let capturedListener: Listener | null = null;
    vi.mocked(subscribeWatch).mockImplementation(
      (_id: string, listener: Listener) => {
        capturedListener = listener;
        return () => undefined;
      },
    );

    await boot();
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/auth/watch/w-1/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Wait for the listener to register, then push a "waiting" event.
    for (let i = 0; i < 40 && !capturedListener; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const ev: WatchEvent = { type: "waiting", elapsedSec: 5 };
    capturedListener!(ev);

    const raw = await readUntil(res, (acc) => acc.includes('"waiting"'));
    controller.abort();

    const frames = parseDataFrames(raw);
    expect(frames[0]).toEqual({ type: "subscribed" });
    expect(frames).toContainEqual({ type: "waiting", elapsedSec: 5 });
  });

  it("emits {type:'error', message:'watch id not found'} + closes when subscribeWatch returns null", async () => {
    vi.mocked(subscribeWatch).mockReturnValue(null);

    await boot();
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/auth/watch/missing/events`, {
      signal: controller.signal,
    });

    const raw = await readUntil(res, (acc) => acc.includes('"error"'));
    controller.abort();

    const frames = parseDataFrames(raw);
    expect(frames).toEqual([
      { type: "subscribed" },
      { type: "error", message: "watch id not found" },
    ]);
  });

  it("persists token + region + email on a 'found' event", async () => {
    let capturedListener: Listener | null = null;
    vi.mocked(subscribeWatch).mockImplementation(
      (_id: string, listener: Listener) => {
        capturedListener = listener;
        return () => undefined;
      },
    );

    await boot();
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/auth/watch/w-42/events`, {
      signal: controller.signal,
    });

    for (let i = 0; i < 40 && !capturedListener; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    capturedListener!({
      type: "found",
      token: {
        token: JWT,
        browser: "Chrome",
        profile: "Default",
        email: "alice@example.com",
        iat: 1_900_000_000,
        exp: EXP_FROM_JWT,
      },
    });

    await readUntil(res, (acc) => acc.includes('"found"'));
    controller.abort();

    const cfg = loadConfig();
    expect(cfg.token).toBe(JWT);
    expect(cfg.tokenEmail).toBe("alice@example.com");
    expect(cfg.tokenExp).toBe(EXP_FROM_JWT);
    expect(cfg.plaudRegion).toBe("us-east");
  });
});
