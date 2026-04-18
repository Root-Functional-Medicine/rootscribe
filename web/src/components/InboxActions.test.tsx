import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  InboxMutationResponse,
  RecordingDetail,
  EffectiveInboxStatus,
} from "@rootscribe/shared";
import { InboxActions } from "./InboxActions.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../test-utils.js";

function makeRecording(
  effectiveInboxStatus: EffectiveInboxStatus,
  overrides: Partial<RecordingDetail> = {},
): RecordingDetail {
  return {
    id: "rec-1",
    filename: "f.ogg",
    startTime: 0,
    endTime: 0,
    durationMs: 0,
    filesizeBytes: 0,
    serialNumber: "",
    folder: "",
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
    inboxStatus:
      effectiveInboxStatus === "snoozed" ? "new" : effectiveInboxStatus,
    effectiveInboxStatus,
    category: null,
    snoozedUntil: effectiveInboxStatus === "snoozed" ? Date.now() + 86_400_000 : null,
    reviewedAt: effectiveInboxStatus === "reviewed" ? Date.now() : null,
    tags: [],
    transcriptText: null,
    summaryMarkdown: null,
    metadata: null,
    inboxNotes: null,
    jiraLinks: [],
    ...overrides,
  };
}

function mutationResponse(
  overrides: Partial<RecordingDetail> = {},
): InboxMutationResponse {
  return {
    recording: {
      ...makeRecording("new"),
      ...overrides,
    },
    availableTags: [],
    availableCategories: [],
  };
}

describe("InboxActions — button surface per effective status", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("on 'new': Mark Reviewed (primary), Snooze, Archive — no Reopen, no Unsnooze", () => {
    renderWithProviders(<InboxActions recording={makeRecording("new")} />);
    expect(screen.getByRole("button", { name: /mark reviewed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reopen/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unsnooze/i })).not.toBeInTheDocument();
  });

  it("on 'snoozed': Unsnooze (instead of Snooze), no Reopen", () => {
    renderWithProviders(<InboxActions recording={makeRecording("snoozed")} />);
    expect(screen.getByRole("button", { name: /unsnooze/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^snooze$/i })).not.toBeInTheDocument();
  });

  it("on 'reviewed': Reviewed (disabled) + Reopen + Archive (Archive is hidden only on 'archived')", () => {
    // Re-documenting the surface: Archive intentionally stays visible on
    // 'reviewed' so a user can archive an item they already marked reviewed
    // without first reopening it. The only state that hides Archive is
    // 'archived' itself.
    renderWithProviders(<InboxActions recording={makeRecording("reviewed")} />);
    expect(screen.getByRole("button", { name: /^reviewed$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
    // Snooze disappears since the recording isn't in the 'new' state.
    expect(screen.queryByRole("button", { name: /^snooze$/i })).not.toBeInTheDocument();
  });

  it("on 'archived': Reopen but no Archive button (hidden when already archived)", () => {
    renderWithProviders(<InboxActions recording={makeRecording("archived")} />);
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
  });
});

describe("InboxActions — mutations", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("Mark Reviewed PATCHes /status with { status: 'reviewed' }", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ inboxStatus: "reviewed" })),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={makeRecording("new")} />);

    await user.click(screen.getByRole("button", { name: /mark reviewed/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/status");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ status: "reviewed" });
  });

  it("Archive PATCHes /status with { status: 'archived' }", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ inboxStatus: "archived" })),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={makeRecording("new")} />);

    await user.click(screen.getByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      status: "archived",
    });
  });

  it("Reopen PATCHes /status with { status: 'new' }", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ inboxStatus: "new" })),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={makeRecording("reviewed")} />);

    await user.click(screen.getByRole("button", { name: /reopen/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      status: "new",
    });
  });

  it("Unsnooze PATCHes /snooze with { snoozedUntil: null }", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={makeRecording("snoozed")} />);

    await user.click(screen.getByRole("button", { name: /unsnooze/i }));
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/snooze");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ snoozedUntil: null });
  });

  it("Snooze opens the SnoozeMenu popover on click; picking a preset PATCHes /snooze", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={makeRecording("new")} />);

    await user.click(screen.getByRole("button", { name: /^snooze$/i }));
    // Popover opened — preset buttons are now available.
    const tomorrow = await screen.findByRole("button", { name: /^tomorrow$/i });
    await user.click(tomorrow);

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body));
    expect(typeof body.snoozedUntil).toBe("number");
    expect(body.snoozedUntil).toBeGreaterThan(Date.now());
  });

  it("surfaces the mutation error message inline when a PATCH fails", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse({ error: "nope" }, { status: 500 }),
    );
    const user = userEvent.setup();
    renderWithProviders(<InboxActions recording={makeRecording("new")} />);

    await user.click(screen.getByRole("button", { name: /mark reviewed/i }));
    expect(await screen.findByText(/nope/i)).toBeInTheDocument();
  });
});
