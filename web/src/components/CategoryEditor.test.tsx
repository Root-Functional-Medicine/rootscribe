import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxMutationResponse, RecordingDetail } from "@rootscribe/shared";
import { CategoryEditor } from "./CategoryEditor.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../test-utils.js";

function mutationResponse(
  overrides: Partial<RecordingDetail> = {},
): InboxMutationResponse {
  return {
    recording: {
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
    } as RecordingDetail,
    availableTags: [],
    availableCategories: [],
  };
}

describe("CategoryEditor — display mode", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders the category inside a chip button when one is set", () => {
    renderWithProviders(
      <CategoryEditor
        recordingId="rec-1"
        category="billing"
        availableCategories={["billing", "support"]}
      />,
    );
    expect(screen.getByRole("button", { name: "billing" })).toBeInTheDocument();
  });

  it("renders the 'Add category…' placeholder button when category is null", () => {
    renderWithProviders(
      <CategoryEditor recordingId="rec-1" category={null} availableCategories={[]} />,
    );
    expect(screen.getByRole("button", { name: /add category/i })).toBeInTheDocument();
  });

  it("shows a clear button alongside the chip only when a category is set", () => {
    const { rerender } = renderWithProviders(
      <CategoryEditor recordingId="rec-1" category="support" availableCategories={[]} />,
    );
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();

    rerender(
      <CategoryEditor recordingId="rec-1" category={null} availableCategories={[]} />,
    );
    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
  });

  it("clears the category immediately (no commit/blur dance) when the clear button is clicked", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ category: null })),
    );
    const user = userEvent.setup();

    renderWithProviders(
      <CategoryEditor recordingId="rec-1" category="billing" availableCategories={[]} />,
    );
    await user.click(screen.getByRole("button", { name: /clear/i }));

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = stub.fetch.mock.calls[0]!;
    expect(url).toBe("/api/recordings/rec-1/category");
    expect(JSON.parse(String(init?.body))).toEqual({ category: null });
  });
});

describe("CategoryEditor — edit mode", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("enters edit mode when the chip is clicked and focuses the input", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CategoryEditor
        recordingId="rec-1"
        category="billing"
        availableCategories={["billing", "support"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "billing" }));
    const editInput = screen.getByRole<HTMLInputElement>("combobox");
    expect(editInput).toHaveFocus();
    expect(editInput).toHaveValue("billing");
  });

  it("commits the new value via PATCH on Enter", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ category: "renamed" })),
    );
    const user = userEvent.setup();

    renderWithProviders(
      <CategoryEditor recordingId="rec-1" category="billing" availableCategories={[]} />,
    );
    await user.click(screen.getByRole("button", { name: "billing" }));
    const input = screen.getByRole<HTMLInputElement>("combobox");
    await user.clear(input);
    await user.type(input, "renamed{Enter}");

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      category: "renamed",
    });
  });

  it("commits on blur when the value changed", async () => {
    stub.fetch.mockResolvedValueOnce(
      jsonResponse(mutationResponse({ category: "triage" })),
    );
    const user = userEvent.setup();

    renderWithProviders(
      <CategoryEditor recordingId="rec-1" category={null} availableCategories={[]} />,
    );
    await user.click(screen.getByRole("button", { name: /add category/i }));
    const input = screen.getByRole<HTMLInputElement>("combobox");
    await user.type(input, "triage");
    await user.tab();

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      category: "triage",
    });
  });

  it("sends category: null when the trimmed draft is empty (not an empty string)", async () => {
    stub.fetch.mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(
      <CategoryEditor recordingId="rec-1" category="billing" availableCategories={[]} />,
    );
    await user.click(screen.getByRole("button", { name: "billing" }));
    const input = screen.getByRole<HTMLInputElement>("combobox");
    await user.clear(input);
    await user.type(input, "   ");
    await user.tab();

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(stub.fetch.mock.calls[0]![1]?.body))).toEqual({
      category: null,
    });
  });

  it("skips the API call when the committed value equals the existing category", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CategoryEditor recordingId="rec-1" category="billing" availableCategories={[]} />,
    );
    await user.click(screen.getByRole("button", { name: "billing" }));
    // Open edit mode; immediately commit via tab without changing the value.
    // We don't need to hold the input reference — the tab fires blur on the
    // focused element.
    expect(screen.getByRole("combobox")).toHaveFocus();
    await user.tab();

    expect(stub.fetch).not.toHaveBeenCalled();
    // And we return to display mode.
    expect(screen.getByRole("button", { name: "billing" })).toBeInTheDocument();
  });

  it("Escape cancels the edit without calling the API, even after typing", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CategoryEditor recordingId="rec-1" category="billing" availableCategories={[]} />,
    );
    await user.click(screen.getByRole("button", { name: "billing" }));
    const input = screen.getByRole<HTMLInputElement>("combobox");
    await user.clear(input);
    await user.type(input, "new typing{Escape}");

    expect(stub.fetch).not.toHaveBeenCalled();
    // The chip shows the ORIGINAL value, not the aborted draft.
    expect(screen.getByRole("button", { name: "billing" })).toBeInTheDocument();
  });

  it("exposes availableCategories as <option> entries inside the datalist", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <CategoryEditor
        recordingId="rec-1"
        category={null}
        availableCategories={["alpha", "beta", "gamma"]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add category/i }));

    // Datalist <option>s don't expose role="option" in happy-dom, so fall
    // back to querySelector. Testing the rendered datalist is the point —
    // no Testing Library API reaches it.
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const options = container.querySelectorAll<HTMLOptionElement>("datalist option");
    expect(Array.from(options).map((o) => o.value)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});
