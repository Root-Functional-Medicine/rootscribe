import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { RecordingDetail } from "@applaud/shared";
import { applyRecordingMutation } from "./recordingCache.js";

function makeRecording(overrides: Partial<RecordingDetail> = {}): RecordingDetail {
  return {
    id: "rec-1",
    filename: "meeting.ogg",
    startTime: 0,
    endTime: 60_000,
    durationMs: 60_000,
    filesizeBytes: 12_345,
    serialNumber: "SN-1",
    folder: "2026/04/11/meeting",
    audioPath: null,
    transcriptPath: null,
    summaryPath: null,
    metadataPath: null,
    audioDownloadedAt: null,
    transcriptDownloadedAt: null,
    webhookAudioFiredAt: null,
    webhookTranscriptFiredAt: null,
    isTrash: false,
    isHistorical: false,
    lastError: null,
    status: "complete",
    inboxStatus: "new",
    effectiveInboxStatus: "new",
    category: null,
    snoozedUntil: null,
    reviewedAt: null,
    tags: [],
    transcriptText: null,
    summaryMarkdown: null,
    metadata: null,
    inboxNotes: null,
    jiraLinks: [],
    ...overrides,
  } as RecordingDetail;
}

describe("applyRecordingMutation", () => {
  it("creates a wrapper from the response when no prior cache entry exists", () => {
    const qc = new QueryClient();
    const recording = makeRecording({ inboxStatus: "reviewed" });

    applyRecordingMutation(qc, "rec-1", {
      recording,
      availableTags: ["alpha"],
      availableCategories: ["work"],
    });

    expect(qc.getQueryData(["recording", "rec-1"])).toEqual({
      recording,
      mediaBase: "",
      availableTags: ["alpha"],
      availableCategories: ["work"],
    });
  });

  it("preserves heavy fields (transcriptText, summaryMarkdown, metadata) from the prior cache entry", () => {
    const qc = new QueryClient();
    const prior = {
      recording: makeRecording({
        transcriptText: "the whole transcript",
        summaryMarkdown: "## summary",
        metadata: { plaudRaw: true },
      }),
      mediaBase: "http://127.0.0.1/media/X",
      availableTags: [],
      availableCategories: [],
    };
    qc.setQueryData(["recording", "rec-1"], prior);

    const mutatedRecording = makeRecording({
      inboxStatus: "reviewed",
      transcriptText: null,
      summaryMarkdown: null,
      metadata: null,
    });

    applyRecordingMutation(qc, "rec-1", {
      recording: mutatedRecording,
      availableTags: ["alpha"],
      availableCategories: ["work"],
    });

    const next = qc.getQueryData<{
      recording: RecordingDetail;
      mediaBase: string;
      availableTags: string[];
      availableCategories: string[];
    }>(["recording", "rec-1"]);

    expect(next?.recording.inboxStatus).toBe("reviewed");
    // Heavy fields survived the mutation.
    expect(next?.recording.transcriptText).toBe("the whole transcript");
    expect(next?.recording.summaryMarkdown).toBe("## summary");
    expect(next?.recording.metadata).toEqual({ plaudRaw: true });
    // mediaBase and autocompletes were preserved/refreshed correctly.
    expect(next?.mediaBase).toBe("http://127.0.0.1/media/X");
    expect(next?.availableTags).toEqual(["alpha"]);
    expect(next?.availableCategories).toEqual(["work"]);
  });

  it("invalidates the recordings list query so dashboard counts update", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["recordings"], { stale: true });

    applyRecordingMutation(qc, "rec-1", {
      recording: makeRecording(),
      availableTags: [],
      availableCategories: [],
    });

    // `invalidateQueries` marks the entry stale without removing the data.
    const state = qc.getQueryState(["recordings"]);
    expect(state?.isInvalidated).toBe(true);
  });
});
