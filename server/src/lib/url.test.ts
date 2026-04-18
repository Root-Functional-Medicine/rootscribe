import { describe, expect, it } from "vitest";
import { encodeFolderPath } from "./url.js";

describe("encodeFolderPath", () => {
  it("passes through safe single-segment names", () => {
    expect(encodeFolderPath("recordings")).toBe("recordings");
  });

  it("preserves slashes between segments", () => {
    expect(encodeFolderPath("2026/04/11")).toBe("2026/04/11");
  });

  it("encodes reserved characters within a segment", () => {
    expect(encodeFolderPath("foo?bar")).toBe("foo%3Fbar");
    expect(encodeFolderPath("foo#bar")).toBe("foo%23bar");
  });

  it("encodes spaces as %20", () => {
    expect(encodeFolderPath("my recording")).toBe("my%20recording");
  });

  it("preserves slash structure while encoding embedded special characters", () => {
    expect(encodeFolderPath("2026/04/my meeting?title")).toBe(
      "2026/04/my%20meeting%3Ftitle",
    );
  });

  it("leaves already-encoded percent sequences double-encoded (encoder does not inspect prior encoding)", () => {
    // This documents existing behavior: encodeURIComponent has no way to
    // recognize "%20" as already-escaped and will escape the '%' itself.
    expect(encodeFolderPath("foo%20bar")).toBe("foo%2520bar");
  });

  it("handles empty strings (single empty segment)", () => {
    expect(encodeFolderPath("")).toBe("");
  });

  it("handles trailing slash by producing a trailing empty segment", () => {
    expect(encodeFolderPath("foo/")).toBe("foo/");
  });
});
