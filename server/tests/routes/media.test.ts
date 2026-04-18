import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const configMock = vi.hoisted(() => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../src/config.js", () => configMock);

const { mediaRouter } = await import("../../src/routes/media.js");
const { makeTestApp } = await import("../helpers/test-server.js");

// Shared filesystem fixture — a recordings dir with a couple of files
// plus an "outside" sibling the traversal tests try to escape to.
let recordingsDir: string;
let outsideDir: string;
let tmpRoot: string;
const audioBytes = Buffer.alloc(100_000, 0x41); // 100 KB of 'A' for range tests

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "rootscribe-media-"));
  recordingsDir = path.join(tmpRoot, "recordings");
  outsideDir = path.join(tmpRoot, "outside");
  mkdirSync(recordingsDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  mkdirSync(path.join(recordingsDir, "2026-04-18_meeting__abc"), { recursive: true });

  writeFileSync(path.join(recordingsDir, "2026-04-18_meeting__abc", "audio.ogg"), audioBytes);
  writeFileSync(
    path.join(recordingsDir, "2026-04-18_meeting__abc", "transcript.json"),
    JSON.stringify({ segments: [] }),
  );
  writeFileSync(
    path.join(recordingsDir, "2026-04-18_meeting__abc", "summary.md"),
    "# Summary\n\nHello.",
  );
  writeFileSync(
    path.join(recordingsDir, "2026-04-18_meeting__abc", "notes.unknown"),
    "raw bytes",
  );
  writeFileSync(path.join(outsideDir, "secret.txt"), "should never be served");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

function mountApp(): ReturnType<typeof makeTestApp> {
  return makeTestApp((a) => a.use("/media", mediaRouter));
}

function configAt(dir: string | null): void {
  configMock.loadConfig.mockReturnValue({
    recordingsDir: dir,
    // The handler only touches recordingsDir, but return a realistic
    // shape so any future code that reads other fields doesn't break.
    setupComplete: true,
    token: "t",
    pollIntervalMinutes: 10,
    jiraBaseUrl: "",
    webhook: null,
    bind: { host: "127.0.0.1", port: 44471 },
  });
}

describe("GET /media/* — config gate", () => {
  it("returns 503 when recordingsDir is null (setup not complete)", async () => {
    configAt(null);
    const res = await request(mountApp()).get("/media/anything.ogg");
    expect(res.status).toBe(503);
    expect(res.text).toContain("not configured");
  });

  it("returns 404 when the path component is empty (trailing slash only)", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-existent file inside a valid recordings dir", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/2026-04-18_meeting__abc/nope.ogg");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a directory path (not a regular file)", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/2026-04-18_meeting__abc");
    expect(res.status).toBe(404);
  });
});

describe("GET /media/* — path-traversal defense", () => {
  it("rejects ../ traversal attempts (decoded)", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/..%2Foutside%2Fsecret.txt");
    expect(res.status).toBe(404);
  });

  it("rejects null-byte smuggling", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/2026-04-18_meeting__abc%2Faudio.ogg%00.txt");
    expect(res.status).toBe(404);
  });

  it("rejects a symlink that escapes the recordings dir", () => {
    configAt(recordingsDir);
    const escape = path.join(recordingsDir, "escape-link");
    // Create an absolute-target symlink pointing at a file outside recordingsDir.
    // Some CI filesystems don't permit symlinks; skip gracefully if so.
    try {
      symlinkSync(path.join(outsideDir, "secret.txt"), escape);
    } catch {
      return;
    }
    return request(mountApp())
      .get("/media/escape-link")
      .then((res) => {
        expect(res.status).toBe(404);
      });
  });
});

describe("GET /media/* — content serving", () => {
  it("serves audio.ogg with Content-Type: audio/ogg and Accept-Ranges: bytes", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp())
      .get("/media/2026-04-18_meeting__abc/audio.ogg")
      .buffer(true);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/ogg");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(Number(res.headers["content-length"])).toBe(audioBytes.byteLength);
  });

  it("maps .json to application/json", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/2026-04-18_meeting__abc/transcript.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("maps .md to text/markdown with charset=utf-8", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/2026-04-18_meeting__abc/summary.md");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp()).get("/media/2026-04-18_meeting__abc/notes.unknown");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });
});

describe("GET /media/* — HTTP Range support", () => {
  it("returns 206 with a valid byte range and correct Content-Range header", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp())
      .get("/media/2026-04-18_meeting__abc/audio.ogg")
      .set("Range", "bytes=0-499")
      .buffer(true);

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-499/${audioBytes.byteLength}`);
    expect(res.headers["content-length"]).toBe("500");
    expect(res.body.byteLength).toBe(500);
  });

  it("defaults end to size-1 when the range is open-ended (bytes=N-)", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp())
      .get("/media/2026-04-18_meeting__abc/audio.ogg")
      .set("Range", "bytes=99000-")
      .buffer(true);

    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(
      `bytes 99000-${audioBytes.byteLength - 1}/${audioBytes.byteLength}`,
    );
  });

  it("returns 416 Range Not Satisfiable when start >= file size", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp())
      .get("/media/2026-04-18_meeting__abc/audio.ogg")
      .set("Range", `bytes=${audioBytes.byteLength + 1}-`);

    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${audioBytes.byteLength}`);
  });

  it("returns 416 when start > end (inverted range)", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp())
      .get("/media/2026-04-18_meeting__abc/audio.ogg")
      .set("Range", "bytes=500-100");

    expect(res.status).toBe(416);
  });

  it("ignores a non-bytes range prefix and serves the full file", async () => {
    configAt(recordingsDir);
    const res = await request(mountApp())
      .get("/media/2026-04-18_meeting__abc/audio.ogg")
      .set("Range", "pages=1-10")
      .buffer(true);

    // Range doesn't start with "bytes=" so the Range branch is skipped.
    expect(res.status).toBe(200);
    expect(Number(res.headers["content-length"])).toBe(audioBytes.byteLength);
  });
});
