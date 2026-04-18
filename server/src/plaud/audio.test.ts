import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

// Stub plaudJson (used by getAudioUrl) at the client module boundary. The
// downloadAudio path additionally stubs global fetch because it hits the
// pre-signed S3 URL directly without going through plaudFetch.
const plaudJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  plaudJson: plaudJsonMock,
}));

const { downloadAudio, getAudioUrl, md5File } = await import("./audio.js");

describe("getAudioUrl", () => {
  beforeEach(() => {
    plaudJsonMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requests the mp3 temp URL by default (no is_opus query)", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      temp_url: "https://s3.example/audio.mp3?sig=xyz",
    });

    const url = await getAudioUrl("abc123");

    expect(url).toBe("https://s3.example/audio.mp3?sig=xyz");
    expect(plaudJsonMock).toHaveBeenCalledWith("/file/temp-url/abc123");
  });

  it("appends ?is_opus=1 when opus=true is requested", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      temp_url: "https://s3.example/audio.ogg",
    });

    await getAudioUrl("abc123", true);

    expect(plaudJsonMock).toHaveBeenCalledWith("/file/temp-url/abc123?is_opus=1");
  });

  it("throws when the response has no temp_url (API degraded)", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      msg: "unavailable",
      // intentionally missing temp_url
    });

    await expect(getAudioUrl("abc123")).rejects.toThrow(/no temp_url.*abc123/);
  });

  it("throws when temp_url is an empty string", async () => {
    // Empty string is falsy under `!res.temp_url`, so this treats "" the
    // same as "missing" — prevents a follow-up fetch('') from doing
    // something surprising.
    plaudJsonMock.mockResolvedValueOnce({ status: 0, temp_url: "" });
    await expect(getAudioUrl("abc123")).rejects.toThrow(/no temp_url/);
  });
});

describe("downloadAudio", () => {
  let tmp: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    plaudJsonMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    tmp = mkdtempSync(path.join(tmpdir(), "rootscribe-audio-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  function streamResponse(
    bytes: Uint8Array,
    init: { status?: number; contentLength?: string | null } = {},
  ): Response {
    const status = init.status ?? 200;
    const headers: Record<string, string> = {};
    if (init.contentLength !== null) {
      headers["content-length"] = init.contentLength ?? String(bytes.byteLength);
    }
    return new Response(bytes as BodyInit, { status, headers });
  }

  it("streams the response body to the destination path and returns the declared size", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      temp_url: "https://s3.example/audio.ogg",
    });
    const payload = new TextEncoder().encode("OggS fake audio bytes");
    fetchMock.mockResolvedValueOnce(streamResponse(payload));

    const dest = path.join(tmp, "out.ogg");
    const size = await downloadAudio("abc123", dest);

    expect(size).toBe(payload.byteLength);
    expect(readFileSync(dest)).toEqual(Buffer.from(payload));
    expect(fetchMock).toHaveBeenCalledWith("https://s3.example/audio.ogg");
  });

  it("returns 0 when the response has no content-length header", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      temp_url: "https://s3.example/audio.ogg",
    });
    const payload = new TextEncoder().encode("x");
    fetchMock.mockResolvedValueOnce(streamResponse(payload, { contentLength: null }));

    const dest = path.join(tmp, "out.ogg");
    const size = await downloadAudio("abc123", dest);

    expect(size).toBe(0);
    expect(readFileSync(dest).byteLength).toBe(payload.byteLength);
  });

  it("throws when the S3 fetch returns a non-2xx status", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      temp_url: "https://s3.example/gone.ogg",
    });
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 404, statusText: "Not Found" }),
    );

    await expect(
      downloadAudio("abc123", path.join(tmp, "out.ogg")),
    ).rejects.toThrow(/audio fetch abc123.*HTTP 404/);
  });

  it("throws when the S3 response body is null (undefined stream)", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      temp_url: "https://s3.example/empty.ogg",
    });
    // A 204 has no body; Response body becomes null.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      downloadAudio("abc123", path.join(tmp, "out.ogg")),
    ).rejects.toThrow(/empty body/);
  });

  it("propagates pipeline write errors (e.g. destination dir does not exist)", async () => {
    plaudJsonMock.mockResolvedValueOnce({
      status: 0,
      temp_url: "https://s3.example/audio.ogg",
    });
    const payload = new TextEncoder().encode("bytes");
    fetchMock.mockResolvedValueOnce(
      new Response(Readable.toWeb(Readable.from([Buffer.from(payload)])) as never, {
        status: 200,
        headers: { "content-length": String(payload.byteLength) },
      }),
    );

    const bogusDest = path.join(tmp, "does-not-exist", "out.ogg");
    await expect(downloadAudio("abc123", bogusDest)).rejects.toBeDefined();
  });
});

describe("md5File", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "rootscribe-md5-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("computes the MD5 of a known string payload", () => {
    const file = path.join(tmp, "hello.txt");
    writeFileSync(file, "hello world");

    // Cross-checked with `md5 -s 'hello world'` / `echo -n 'hello world' | md5sum`.
    const expected = createHash("md5").update("hello world").digest("hex");
    expect(md5File(file)).toBe(expected);
    expect(md5File(file)).toHaveLength(32);
  });

  it("returns the empty-file MD5 (d41d8cd98f00b204e9800998ecf8427e) for a zero-byte file", () => {
    const file = path.join(tmp, "empty.bin");
    writeFileSync(file, "");

    expect(md5File(file)).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("handles binary content correctly (Buffer, not string)", () => {
    const file = path.join(tmp, "bin.dat");
    const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x41, 0x42]);
    writeFileSync(file, bytes);

    const expected = createHash("md5").update(bytes).digest("hex");
    expect(md5File(file)).toBe(expected);
  });
});
