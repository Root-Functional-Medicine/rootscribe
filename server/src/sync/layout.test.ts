import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dateStamp,
  ensureRecordingFolder,
  folderName,
  recordingPaths,
  sanitizeFilename,
} from "./layout.js";

describe("sanitizeFilename", () => {
  it("passes through safe ASCII names", () => {
    expect(sanitizeFilename("my-recording")).toBe("my-recording");
  });

  it("replaces path-unsafe characters with underscores", () => {
    // All nine of the regex-banned chars: /, \, :, *, ?, ", <, >, |
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("replaces CR/LF/tab with underscores (guards against header-injection style names)", () => {
    expect(sanitizeFilename("foo\r\n\tbar")).toBe("foo_bar");
  });

  it("collapses whitespace into single underscores", () => {
    expect(sanitizeFilename("   multi    space   name   ")).toBe("multi_space_name");
  });

  it("collapses consecutive underscores down to one", () => {
    expect(sanitizeFilename("a___b____c")).toBe("a_b_c");
  });

  it("strips leading and trailing dots and underscores", () => {
    expect(sanitizeFilename("...__foo__...")).toBe("foo");
  });

  it("truncates to 100 characters (the slice bound)", () => {
    const long = "x".repeat(200);
    expect(sanitizeFilename(long)).toHaveLength(100);
  });

  it("returns an empty string when the input is all-unsafe and would leave nothing", () => {
    // All underscores after substitution; leading/trailing strip leaves "".
    expect(sanitizeFilename("///___...")).toBe("");
  });

  it("handles the empty string", () => {
    expect(sanitizeFilename("")).toBe("");
  });
});

describe("dateStamp", () => {
  it("formats a UTC date as YYYY-MM-DD", () => {
    // 2026-04-18 12:34:56 UTC
    const ms = Date.UTC(2026, 3, 18, 12, 34, 56);
    expect(dateStamp(ms)).toBe("2026-04-18");
  });

  it("zero-pads single-digit months and days", () => {
    const ms = Date.UTC(2026, 0, 5, 0, 0, 0); // Jan 5
    expect(dateStamp(ms)).toBe("2026-01-05");
  });

  it("uses UTC regardless of the local timezone (no off-by-one near midnight)", () => {
    // Exactly midnight UTC on 2026-04-18 — in local time this could be the
    // 17th or the 18th depending on the host's timezone. Using UTC means
    // the folder date matches the timestamp the Plaud API returned.
    const ms = Date.UTC(2026, 3, 18, 0, 0, 0);
    expect(dateStamp(ms)).toBe("2026-04-18");
  });
});

describe("folderName", () => {
  it("composes date + sanitized name + short id", () => {
    const ms = Date.UTC(2026, 3, 18, 12, 0, 0);
    expect(folderName(ms, "Team sync meeting", "abcdef1234567890")).toBe(
      "2026-04-18_Team_sync_meeting__abcdef12",
    );
  });

  it("falls back to 'recording' when the filename sanitizes to an empty string", () => {
    const ms = Date.UTC(2026, 3, 18, 12, 0, 0);
    expect(folderName(ms, "///___...", "abcdef1234")).toBe(
      "2026-04-18_recording__abcdef12",
    );
  });

  it("truncates the id to the first 8 characters", () => {
    const ms = Date.UTC(2026, 3, 18, 12, 0, 0);
    const name = folderName(ms, "test", "abcdefghijklmnop");
    expect(name.endsWith("__abcdefgh")).toBe(true);
  });
});

describe("recordingPaths", () => {
  it("joins the recordings dir and folder name, then appends each standard filename", () => {
    const paths = recordingPaths("/data/recordings", "2026-04-18_meeting__abcdef12");

    expect(paths).toEqual({
      folder: path.join("/data/recordings", "2026-04-18_meeting__abcdef12"),
      audioPath: path.join(
        "/data/recordings",
        "2026-04-18_meeting__abcdef12",
        "audio.ogg",
      ),
      transcriptJsonPath: path.join(
        "/data/recordings",
        "2026-04-18_meeting__abcdef12",
        "transcript.json",
      ),
      transcriptTxtPath: path.join(
        "/data/recordings",
        "2026-04-18_meeting__abcdef12",
        "transcript.txt",
      ),
      summaryMdPath: path.join(
        "/data/recordings",
        "2026-04-18_meeting__abcdef12",
        "summary.md",
      ),
      metadataPath: path.join(
        "/data/recordings",
        "2026-04-18_meeting__abcdef12",
        "metadata.json",
      ),
    });
  });
});

describe("ensureRecordingFolder", () => {
  // Each test owns its own tmp dir so parallel workers don't collide on mkdir.
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the folder on disk and returns the full RecordingPaths", () => {
    tmp = mkdtempSync(path.join(tmpdir(), "rootscribe-layout-"));
    const paths = ensureRecordingFolder(tmp, "2026-04-18_meeting__abcdef12");

    expect(existsSync(paths.folder)).toBe(true);
    expect(paths.folder).toBe(path.join(tmp, "2026-04-18_meeting__abcdef12"));
    expect(paths.audioPath.endsWith("audio.ogg")).toBe(true);
  });

  it("is idempotent — calling twice does not throw (mkdirSync recursive: true)", () => {
    tmp = mkdtempSync(path.join(tmpdir(), "rootscribe-layout-"));
    const folder = "2026-04-18_meeting__abcdef12";

    expect(() => ensureRecordingFolder(tmp, folder)).not.toThrow();
    expect(() => ensureRecordingFolder(tmp, folder)).not.toThrow();
  });

  it("creates intermediate parent directories when the recordings dir does not yet exist", () => {
    tmp = mkdtempSync(path.join(tmpdir(), "rootscribe-layout-"));
    const nested = path.join(tmp, "does", "not", "exist", "yet");

    const paths = ensureRecordingFolder(nested, "child");
    expect(existsSync(paths.folder)).toBe(true);
  });
});
