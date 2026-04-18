import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxMutationResponse, JiraLink, RecordingDetail } from "@rootscribe/shared";
import { JiraLinksEditor } from "./JiraLinksEditor.js";
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

function configResponse(jiraBaseUrl: string): Response {
  return jsonResponse({
    config: {
      setupComplete: true,
      token: "t",
      recordingsDir: "/tmp",
      pollIntervalMinutes: 10,
      jiraBaseUrl,
      webhook: null,
      bind: { host: "127.0.0.1", port: 44471 },
    },
  });
}

const ROOT_101: JiraLink = {
  id: 1,
  issueKey: "ROOT-101",
  issueUrl: "https://example.atlassian.net/browse/ROOT-101",
  relation: "created_from",
  createdAt: 1,
};

describe("JiraLinksEditor — rendering existing links", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
    // config query always fires on mount.
    stub.fetch.mockResolvedValue(configResponse("https://example.atlassian.net/browse/"));
  });
  afterEach(() => stub.cleanup());

  it("renders 'No linked issues' when the links array is empty", () => {
    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[]} />);
    expect(screen.getByText(/no linked issues/i)).toBeInTheDocument();
  });

  it("renders each link as a clickable anchor when the stored URL uses https", async () => {
    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[ROOT_101]} />);
    const link = await screen.findByRole("link", { name: /ROOT-101/i });
    expect(link).toHaveAttribute("href", ROOT_101.issueUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("falls back to the configured base URL when the stored URL is null", async () => {
    renderWithProviders(
      <JiraLinksEditor
        recordingId="rec-1"
        links={[{ ...ROOT_101, issueUrl: null }]}
      />,
    );
    // Config must resolve first for the base URL to be used.
    const link = await screen.findByRole("link", { name: /ROOT-101/i });
    expect(link).toHaveAttribute("href", "https://example.atlassian.net/browse/ROOT-101");
  });

  it("degrades to a non-clickable <span> when the stored URL isn't http(s) (defense against javascript: rows)", async () => {
    renderWithProviders(
      <JiraLinksEditor
        recordingId="rec-1"
        links={[
          { ...ROOT_101, issueUrl: "javascript:alert(1)" },
        ]}
      />,
    );
    // Wait for any async config state to settle.
    await screen.findByText("ROOT-101");
    // No <a> element exists.
    expect(screen.queryByRole("link", { name: /ROOT-101/i })).not.toBeInTheDocument();
  });
});

describe("JiraLinksEditor — adding links", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("disables the submit button until the input contains a valid Jira key", async () => {
    stub.fetch.mockResolvedValue(configResponse(""));
    const user = userEvent.setup();

    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[]} />);
    const input = screen.getByPlaceholderText("ISSUE-123");
    // Empty draft, neutral label.
    expect(screen.getByRole("button", { name: /^link issue$/i })).toBeDisabled();

    // Invalid key — label changes, still disabled.
    await user.type(input, "not-a-key");
    expect(screen.getByRole("button", { name: /invalid key/i })).toBeDisabled();

    // Valid key — button becomes enabled with the primary label.
    await user.clear(input);
    await user.type(input, "ROOT-456");
    expect(screen.getByRole("button", { name: /^link issue$/i })).not.toBeDisabled();
  });

  it("uppercases the typed key and submits it to POST /jira-links", async () => {
    // First fetch: config; second fetch: the POST mutation.
    stub.fetch
      .mockResolvedValueOnce(configResponse("https://example.atlassian.net/browse/"))
      .mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[]} />);
    await user.type(screen.getByPlaceholderText("ISSUE-123"), "root-202");
    await user.click(screen.getByRole("button", { name: /^link issue$/i }));

    // First call is config; second is the mutation.
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(2));
    const [url, init] = stub.fetch.mock.calls[1]!;
    expect(url).toBe("/api/recordings/rec-1/jira-links");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.issueKey).toBe("ROOT-202");
    // Auto-built URL from jiraBaseUrl + key.
    expect(body.issueUrl).toBe("https://example.atlassian.net/browse/ROOT-202");
  });

  it("uses the caller's explicit URL over the configured base when both are provided", async () => {
    stub.fetch
      .mockResolvedValueOnce(configResponse("https://ignored.atlassian.net/browse/"))
      .mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[]} />);
    await user.type(screen.getByPlaceholderText("ISSUE-123"), "ROOT-500");
    await user.type(
      screen.getByPlaceholderText(/https?:\/\//i),
      "https://explicit.example/x/ROOT-500",
    );
    await user.click(screen.getByRole("button", { name: /^link issue$/i }));

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(stub.fetch.mock.calls[1]![1]?.body));
    expect(body.issueUrl).toBe("https://explicit.example/x/ROOT-500");
  });

  it("clears the inputs after a successful add (tied to onSuccess, not click)", async () => {
    stub.fetch
      .mockResolvedValueOnce(configResponse(""))
      .mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[]} />);
    const keyInput = screen.getByPlaceholderText<HTMLInputElement>("ISSUE-123");
    await user.type(keyInput, "ROOT-9");
    await user.click(screen.getByRole("button", { name: /^link issue$/i }));

    await waitFor(() => expect(keyInput).toHaveValue(""));
  });

  it("treats duplicates as client-side no-ops (clears inputs, no POST)", async () => {
    stub.fetch.mockResolvedValue(configResponse(""));
    const user = userEvent.setup();

    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[ROOT_101]} />);
    const keyInput = screen.getByPlaceholderText<HTMLInputElement>("ISSUE-123");
    await user.type(keyInput, "ROOT-101{Enter}");

    // Only the config call should have fired (duplicate short-circuited).
    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(1));
    expect(keyInput).toHaveValue("");
  });

  it("surfaces server error messages inline when the mutation fails", async () => {
    stub.fetch
      .mockResolvedValueOnce(configResponse(""))
      .mockResolvedValueOnce(
        jsonResponse({ error: "bad request" }, { status: 400 }),
      );
    const user = userEvent.setup();

    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[]} />);
    await user.type(screen.getByPlaceholderText("ISSUE-123"), "ROOT-1");
    await user.click(screen.getByRole("button", { name: /^link issue$/i }));

    expect(await screen.findByText(/couldn't link issue/i)).toBeInTheDocument();
  });
});

describe("JiraLinksEditor — removing links", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
    stub.fetch.mockResolvedValue(configResponse(""));
  });
  afterEach(() => stub.cleanup());

  it("clicks the 'Unlink ROOT-101' button to DELETE the link", async () => {
    stub.fetch
      .mockResolvedValueOnce(configResponse(""))
      .mockResolvedValueOnce(jsonResponse(mutationResponse()));
    const user = userEvent.setup();

    renderWithProviders(<JiraLinksEditor recordingId="rec-1" links={[ROOT_101]} />);
    await user.click(screen.getByRole("button", { name: /unlink ROOT-101/i }));

    await waitFor(() => expect(stub.fetch).toHaveBeenCalledTimes(2));
    const [url, init] = stub.fetch.mock.calls[1]!;
    expect(url).toBe("/api/recordings/rec-1/jira-links/ROOT-101");
    expect(init?.method).toBe("DELETE");
  });
});
