import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDetailData, FileDetailResponse } from "./detail.js";

const plaudJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  plaudJson: plaudJsonMock,
}));

const { getFileDetail } = await import("./detail.js");

function makeData(overrides: Partial<FileDetailData> = {}): FileDetailData {
  // Mirror the full FileDetailData shape so nothing downstream trips on a
  // partial mock (see testing-anti-patterns: incomplete mocks).
  return {
    file_id: "abc123",
    file_name: "2026-04-18 meeting",
    file_version: 1,
    duration: 120,
    is_trash: false,
    start_time: 1_775_000_000_000,
    scene: 0,
    serial_number: "SN-001",
    session_id: 42,
    filetag_id_list: [],
    content_list: [
      {
        data_id: "t1",
        data_type: "transaction",
        task_status: 2,
        err_code: "",
        err_msg: "",
        data_title: "Transcript",
        data_tab_name: "trans",
        data_link: "https://s3.example/t1.json",
      },
    ],
    embeddings: {},
    download_path_mapping: {},
    pre_download_content_list: [],
    extra_data: null,
    has_thought_partner: false,
    ...overrides,
  };
}

function makeResponse(data: FileDetailData): FileDetailResponse {
  return {
    status: 0,
    msg: "ok",
    request_id: "req-1",
    data,
  };
}

describe("getFileDetail", () => {
  beforeEach(() => {
    plaudJsonMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requests /file/detail/<id>", async () => {
    plaudJsonMock.mockResolvedValueOnce(makeResponse(makeData()));

    await getFileDetail("abc123");

    expect(plaudJsonMock).toHaveBeenCalledWith("/file/detail/abc123");
  });

  it("URL-encodes nothing special — ids are Plaud-generated and assumed safe", async () => {
    // Plaud file ids are 24-char hex-like tokens; detail.ts deliberately
    // does not re-encode them. This test pins that behavior so a defensive
    // encodeURIComponent added later (that would break the real API) is caught.
    plaudJsonMock.mockResolvedValueOnce(makeResponse(makeData()));

    await getFileDetail("abc+123/weird");

    expect(plaudJsonMock).toHaveBeenCalledWith("/file/detail/abc+123/weird");
  });

  it("unwraps the { status, msg, data } envelope and returns .data", async () => {
    const data = makeData({ file_id: "xyz", file_name: "standup" });
    plaudJsonMock.mockResolvedValueOnce(makeResponse(data));

    const got = await getFileDetail("xyz");

    expect(got).toBe(data);
    expect(got.file_id).toBe("xyz");
    expect(got.file_name).toBe("standup");
  });

  it("preserves the content_list array inside .data (downstream transcript fetch depends on it)", async () => {
    const data = makeData({
      content_list: [
        {
          data_id: "t1",
          data_type: "transaction",
          task_status: 2,
          err_code: "",
          err_msg: "",
          data_title: "Transcript",
          data_tab_name: "trans",
          data_link: "https://s3.example/t1.json",
        },
        {
          data_id: "s1",
          data_type: "auto_sum_note",
          task_status: 2,
          err_code: "",
          err_msg: "",
          data_title: "Summary",
          data_tab_name: "summ",
          data_link: "https://s3.example/s1.md",
        },
      ],
    });
    plaudJsonMock.mockResolvedValueOnce(makeResponse(data));

    const got = await getFileDetail("abc123");
    expect(got.content_list).toHaveLength(2);
    expect(got.content_list[0].data_type).toBe("transaction");
    expect(got.content_list[1].data_type).toBe("auto_sum_note");
  });

  it("propagates errors from plaudJson (no internal swallowing)", async () => {
    plaudJsonMock.mockRejectedValueOnce(new Error("Plaud /file/detail/abc123 → 500"));

    await expect(getFileDetail("abc123")).rejects.toThrow(/500/);
  });
});
