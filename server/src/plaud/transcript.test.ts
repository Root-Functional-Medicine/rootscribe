import { describe, expect, it } from "vitest";
import { extractSummaryMarkdown } from "./transcript.js";
import type { TranssummResponse } from "./transcript.js";

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
});
