import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import type {
  RecordingDetail,
  RecordingDetailResponse,
} from "@rootscribe/shared";
import { DEFAULT_CONFIG } from "@rootscribe/shared";
import { RecordingDetailPage } from "./RecordingDetail.js";
import {
  jsonResponse,
  makeRecordingDetail,
  renderWithProviders,
  stubFetch,
} from "../test-utils.js";

// RecordingDetailPage is a ~660-LOC component that composes the detail query
// + delete mutation + audio player + transcript parser/search + summary
// markdown + four sidebar editors (Category/Tag/Jira/Notes). Each editor is
// covered by its own test file; here we focus on the page-level wiring +
// page-specific behaviors (breadcrumb, audio controls, transcript search,
// summary modal, details section, delete flow).
//
// happy-dom stubs HTMLAudioElement enough that ref + method calls don't
// throw. play()/pause() don't emit real "play"/"pause" events, so tests that
// want to observe isPlaying toggle dispatch the events manually.

function detailResponse(
  overrides: Partial<RecordingDetail> = {},
  extras: Partial<Omit<RecordingDetailResponse, "recording">> = {},
): RecordingDetailResponse {
  return {
    recording: makeRecordingDetail(overrides),
    mediaBase: "/media/rec-1",
    availableTags: [],
    availableCategories: [],
    ...extras,
  };
}

// Render RecordingDetailPage under a route that supplies `id` via useParams,
// matching the production routing in App.tsx (`/recordings/:id`).
function renderDetail(id = "rec-1", opts: Parameters<typeof renderWithProviders>[1] = {}) {
  return renderWithProviders(
    <Routes>
      <Route path="/recordings/:id" element={<RecordingDetailPage />} />
    </Routes>,
    { routerEntries: [`/recordings/${id}`], ...opts },
  );
}

// One switch for the whole page's fetches. Routes GET /api/recordings/:id +
// DELETE + any child-component mutations (tag/category/notes/jira) that may
// fire during a test.
function routeDetailFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    detail?: RecordingDetailResponse;
    detailPending?: boolean;
    detailError?: boolean;
    deleteOk?: boolean;
  } = {},
): void {
  stub.fetch.mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    // JiraLinksEditor (a child of this page) pulls /api/config for the
    // jiraBaseUrl. Without a real response it throws and crashes the whole
    // tree — no error boundary in the component tree to catch it. Return a
    // populated default config so the child renders cleanly.
    if (url === "/api/config" && method === "GET") {
      return Promise.resolve(jsonResponse({ config: DEFAULT_CONFIG }));
    }
    if (url.startsWith("/api/recordings/") && method === "DELETE") {
      return Promise.resolve(jsonResponse({ ok: opts.deleteOk ?? true }));
    }
    if (url.startsWith("/api/recordings/") && method === "GET") {
      if (opts.detailPending) return new Promise(() => undefined);
      if (opts.detailError) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(jsonResponse(opts.detail ?? detailResponse()));
    }
    // Child-component mutation fall-through: always succeed with a fresh
    // InboxMutationResponse shape.
    if (url.startsWith("/api/recordings/")) {
      return Promise.resolve(
        jsonResponse({
          recording: opts.detail?.recording ?? makeRecordingDetail(),
          availableTags: [],
          availableCategories: [],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("RecordingDetailPage — load states", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows a loading placeholder while the detail query is pending", () => {
    routeDetailFetch(stub, { detailPending: true });
    renderDetail();
    expect(screen.getByText(/^loading…$/i)).toBeInTheDocument();
  });

  it("renders a 'Not found.' + Back link when the detail query errors", async () => {
    routeDetailFetch(stub, { detailError: true });
    renderDetail();
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute(
      "href",
      "/",
    );
  });
});

describe("RecordingDetailPage — header", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders filename, status pill, formatted duration + file size", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({
        id: "rec-1",
        filename: "standup.ogg",
        durationMs: (1 * 3600 + 5 * 60 + 12) * 1000, // 1h 5m 12s
        filesizeBytes: 2.5 * 1024 * 1024,
        effectiveInboxStatus: "reviewed",
      }),
    });
    renderDetail();
    // filename appears twice: breadcrumb + h1; that's fine — both roles are
    // the expected production behavior.
    expect(await screen.findByRole("heading", { name: /standup/i }))
      .toBeInTheDocument();
    expect(screen.getByText("1h 5m 12s")).toBeInTheDocument();
    expect(screen.getByText(/2\.5 MB/)).toBeInTheDocument();
    // Status pill reflects the current effectiveInboxStatus label.
    expect(
      screen.getByText((t) => t.trim() === "REVIEWED"),
    ).toBeInTheDocument();
  });

  it("breadcrumb 'Recordings' link routes back to the dashboard", async () => {
    routeDetailFetch(stub, { detail: detailResponse() });
    renderDetail();
    const back = await screen.findByRole("link", { name: /recordings/i });
    expect(back).toHaveAttribute("href", "/");
  });

  it("formats durations under an hour as 'Xm Ys' and under a minute as 'Ys'", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ durationMs: 45 * 1000 }),
    });
    const { unmount } = renderDetail();
    expect(await screen.findByText("45s")).toBeInTheDocument();
    unmount();

    // Second scenario: under-an-hour.
    stub.cleanup();
    stub = stubFetch();
    routeDetailFetch(stub, {
      detail: detailResponse({ durationMs: (3 * 60 + 20) * 1000 }),
    });
    renderDetail();
    expect(await screen.findByText("3m 20s")).toBeInTheDocument();
  });
});

describe("RecordingDetailPage — delete flow", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cancels deletion when the user rejects the confirm dialog", async () => {
    // happy-dom doesn't ship window.confirm, so vi.spyOn fails. Stub the
    // global function directly — this is the same thing the delete handler
    // reaches via the bare `confirm(...)` call.
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    routeDetailFetch(stub, { detail: detailResponse() });
    const user = userEvent.setup();
    renderDetail();
    await user.click(
      await screen.findByRole("button", { name: /delete recording/i }),
    );
    // No DELETE hit — the cancel short-circuits before api.deleteRecording.
    expect(
      stub.fetch.mock.calls.some(
        ([i, init]) =>
          String(i).startsWith("/api/recordings/") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("calls api.deleteRecording on the correct id when the user confirms", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    routeDetailFetch(stub, {
      detail: detailResponse({ id: "rec-42" }),
    });
    const user = userEvent.setup();
    renderDetail("rec-42");
    await user.click(
      await screen.findByRole("button", { name: /delete recording/i }),
    );
    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(
          ([i, init]) =>
            String(i) === "/api/recordings/rec-42" &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });
});

describe("RecordingDetailPage — audio player", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("does not render the audio card when audioDownloadedAt is null", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ audioDownloadedAt: null }),
    });
    renderDetail();
    await screen.findByRole("heading", { name: /f\.ogg/i });
    expect(
      screen.queryByTitle(/skip back 10 seconds/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle(/skip forward 30 seconds/i),
    ).not.toBeInTheDocument();
  });

  it("renders the audio card + download link when audio is available", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse(
        { audioDownloadedAt: Date.now() },
        { mediaBase: "/media/rec-1" },
      ),
    });
    renderDetail();
    await screen.findByTitle(/skip back 10 seconds/i);
    const download = screen.getByRole("link", { name: /download/i });
    expect(download).toHaveAttribute("href", "/media/rec-1/audio.ogg");
    expect(download).toHaveAttribute("download");
  });

  it("togglePlay calls play()/pause() on the audio element depending on current paused state", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ audioDownloadedAt: Date.now() }),
    });
    const user = userEvent.setup();
    const { container } = renderDetail();
    await screen.findByTitle(/skip back 10 seconds/i);
    // The <audio> element is hidden — no role, no label — so we reach for
    // container.querySelector. Testing Library doesn't surface a friendlier
    // accessor for media elements.
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const audio = container.querySelector("audio") as HTMLAudioElement;
    const playSpy = vi
      .spyOn(audio, "play")
      .mockReturnValue(undefined as unknown as Promise<void>);
    const pauseSpy = vi.spyOn(audio, "pause").mockReturnValue(undefined);
    // happy-dom: audio.paused defaults to true, so first click → play.
    // Play button is identified by the triangular polygon shape ("▶").
    const playBtn = screen.getAllByRole("button").find((b) =>
      // eslint-disable-next-line testing-library/no-node-access
      b.querySelector("polygon")?.getAttribute("points") === "6 3 20 12 6 21 6 3",
    ) as HTMLButtonElement;
    await user.click(playBtn);
    expect(playSpy).toHaveBeenCalledTimes(1);

    // Flip to playing, click again → pause.
    Object.defineProperty(audio, "paused", { value: false, configurable: true });
    await user.click(playBtn);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it("skip-back subtracts 10s and skip-forward adds 30s to currentTime", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ audioDownloadedAt: Date.now() }),
    });
    const user = userEvent.setup();
    const { container } = renderDetail();
    await screen.findByTitle(/skip back 10 seconds/i);
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const audio = container.querySelector("audio") as HTMLAudioElement;
    audio.currentTime = 60;

    await user.click(screen.getByTitle(/skip back 10 seconds/i));
    expect(audio.currentTime).toBe(50);
    await user.click(screen.getByTitle(/skip forward 30 seconds/i));
    expect(audio.currentTime).toBe(80);
  });
});

describe("RecordingDetailPage — transcript", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows the pending-transcript note when audio is downloaded but transcript isn't", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({
        audioDownloadedAt: Date.now(),
        transcriptText: null,
      }),
    });
    renderDetail();
    expect(
      await screen.findByText(/transcript is still pending/i),
    ).toBeInTheDocument();
  });

  it("parses [MM:SS] Speaker: text blocks and renders them with timestamps + speaker labels", async () => {
    const transcript = [
      "[00:05] Alice: Hello there.",
      "",
      "[00:12] Bob: General Kenobi.",
      "",
      "[01:30] Alice: You are a bold one.",
    ].join("\n");
    routeDetailFetch(stub, {
      detail: detailResponse({ transcriptText: transcript }),
    });
    renderDetail();

    // Wait for the transcript blocks to render; Alice appears in two
    // blocks so getAllByText is the correct query here.
    await waitFor(() =>
      expect(screen.getAllByText("Alice").length).toBe(2),
    );
    expect(screen.getByText("Bob")).toBeInTheDocument();
    // Timestamps appear verbatim in the per-block timestamp column.
    expect(screen.getByText("00:05")).toBeInTheDocument();
    expect(screen.getByText("00:12")).toBeInTheDocument();
    expect(screen.getByText("01:30")).toBeInTheDocument();
    // Block text renders.
    expect(screen.getByText(/General Kenobi\./)).toBeInTheDocument();
    expect(screen.getByText(/Hello there\./)).toBeInTheDocument();
  });

  it("falls back to a <pre>-wrapped raw transcript when no [timestamp] blocks are present", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({
        transcriptText: "freeform notes without any timestamps at all",
      }),
    });
    renderDetail();
    expect(
      await screen.findByText(/freeform notes without any timestamps/i),
    ).toBeInTheDocument();
  });
});

describe("RecordingDetailPage — transcript search", () => {
  let stub: ReturnType<typeof stubFetch>;
  const transcript = [
    "[00:05] Alice: Hello there friend.",
    "",
    "[00:12] Bob: I am your friend.",
    "",
    "[01:30] Alice: Hello again.",
  ].join("\n");

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("opens the search input when the search button is clicked, and shows 0/0 only when the query has no matches", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ transcriptText: transcript }),
    });
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("00:05");
    // Opening the search pane alone doesn't render a match counter — the
    // component only shows one once `searchQuery` is non-empty.
    // title="Search transcript (Ctrl+F)" on the magnifier button.
    await user.click(screen.getByTitle(/search transcript/i));
    const input = await screen.findByPlaceholderText(/search…/i);
    expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();

    // Typing a query that doesn't appear anywhere shows the empty-match
    // indicator "0/0".
    await user.type(input, "zzznomatch");
    expect(await screen.findByText("0/0")).toBeInTheDocument();
  });

  it("shows the match count + highlights as the user types", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ transcriptText: transcript }),
    });
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("00:05");
    await user.click(screen.getByTitle(/search transcript/i));
    const input = await screen.findByPlaceholderText(/search…/i);
    await user.type(input, "friend");
    // Two matches — one in Alice's line, one in Bob's line.
    expect(await screen.findByText("1/2")).toBeInTheDocument();
  });

  it("Enter advances to next match; Shift+Enter goes back", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ transcriptText: transcript }),
    });
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("00:05");
    await user.click(screen.getByTitle(/search transcript/i));
    const input = await screen.findByPlaceholderText(/search…/i);
    await user.type(input, "friend");
    expect(await screen.findByText("1/2")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(await screen.findByText("2/2")).toBeInTheDocument();

    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(await screen.findByText("1/2")).toBeInTheDocument();
  });

  it("Escape closes the search bar and clears the query", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ transcriptText: transcript }),
    });
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("00:05");
    await user.click(screen.getByTitle(/search transcript/i));
    const input = await screen.findByPlaceholderText(/search…/i);
    await user.type(input, "friend");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(/search…/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("Ctrl+F globally opens the search input and focuses it", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ transcriptText: transcript }),
    });
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("00:05");
    // Global keydown handler — fires document.keydown regardless of focus.
    await user.keyboard("{Control>}f{/Control}");
    expect(
      await screen.findByPlaceholderText(/search…/i),
    ).toBeInTheDocument();
  });
});

describe("RecordingDetailPage — summary card + modal", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders the AI Summary card with markdown when summaryMarkdown is set", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({
        summaryMarkdown: "## Key point\n\nThis is the summary.",
      }),
    });
    renderDetail();
    expect(
      await screen.findByRole("heading", { name: /key point/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/ai summary/i).length).toBeGreaterThan(0);
  });

  it("does not render the AI Summary section when summaryMarkdown is null", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ summaryMarkdown: null }),
    });
    renderDetail();
    await screen.findByRole("heading", { name: /f\.ogg/i });
    expect(screen.queryByText(/ai summary/i)).not.toBeInTheDocument();
  });

  it("clicking 'Expand summary' opens the modal; clicking Close dismisses it", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({
        summaryMarkdown: "## Modal test\n\nbody",
      }),
    });
    const user = userEvent.setup();
    renderDetail();
    await user.click(
      await screen.findByTitle(/expand summary/i),
    );
    // Modal renders the same heading — now TWO copies of "Modal test" exist.
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { name: /modal test/i }))
        .toHaveLength(2),
    );
    await user.click(screen.getByTitle(/^close$/i));
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { name: /modal test/i }))
        .toHaveLength(1),
    );
  });
});

describe("RecordingDetailPage — details + metadata section", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders the id, device, folder, and a COMPLETE badge when audio + transcript are both downloaded", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({
        id: "rec-abc",
        serialNumber: "SN123",
        folder: "2026-04-18__abc",
        audioDownloadedAt: Date.now(),
        transcriptDownloadedAt: Date.now(),
      }),
    });
    renderDetail("rec-abc");
    expect(await screen.findByText("rec-abc")).toBeInTheDocument();
    expect(screen.getByText("SN123")).toBeInTheDocument();
    expect(screen.getByText("2026-04-18__abc")).toBeInTheDocument();
    expect(screen.getByText("COMPLETE")).toBeInTheDocument();
  });

  it("renders PENDING when either audio or transcript is still missing", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({
        audioDownloadedAt: Date.now(),
        transcriptDownloadedAt: null,
      }),
    });
    renderDetail();
    expect(await screen.findByText("PENDING")).toBeInTheDocument();
  });

  it("renders a Last error row only when lastError is set", async () => {
    routeDetailFetch(stub, {
      detail: detailResponse({ lastError: "download timeout" }),
    });
    const { unmount } = renderDetail();
    expect(await screen.findByText(/download timeout/i)).toBeInTheDocument();
    unmount();

    stub.cleanup();
    stub = stubFetch();
    routeDetailFetch(stub, {
      detail: detailResponse({ lastError: null }),
    });
    renderDetail();
    await screen.findByRole("heading", { name: /f\.ogg/i });
    expect(screen.queryByText(/last error/i)).not.toBeInTheDocument();
  });

  it("renders a 'Reviewed' label with a formatted timestamp when reviewedAt is set", async () => {
    // Mock toLocaleString() so the timestamp assertion isn't locale-dependent
    // — production uses the raw toLocaleString() output, so we just need a
    // stable string to match against.
    const fixed = "REVIEWED-TIMESTAMP-FIXTURE";
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue(fixed);

    routeDetailFetch(stub, {
      detail: detailResponse({
        reviewedAt: new Date("2026-04-17T12:00:00Z").getTime(),
      }),
    });
    renderDetail();

    // Both the label and the formatted timestamp must render — the latter is
    // the assertion Copilot called out as missing.
    expect(
      await screen.findByText((t) => t.trim().toUpperCase() === "REVIEWED"),
    ).toBeInTheDocument();
    // Every Date field on the page renders via toLocaleString → the fixture
    // string appears multiple times (startTime, audioDownloadedAt, etc.).
    // Assert at least one instance of the fixed string is in the DOM to
    // prove the reviewedAt timestamp made it through formatDate().
    expect(screen.getAllByText(fixed).length).toBeGreaterThan(0);
  });
});
