import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RecordingRow, RecordingsListResponse } from "@rootscribe/shared";
import { Dashboard } from "./Dashboard.js";
import {
  jsonResponse,
  makeRecordingDetail,
  renderWithProviders,
  stubFetch,
} from "../test-utils.js";

// Dashboard composes the listRecordings query + the facets query + a sync
// trigger mutation. Every test goes through the REAL jsonFetch → fetch
// pipeline via a stubbed global.fetch so we exercise query-string building
// and response parsing. The only thing we stub is the network boundary.

function makeRow(overrides: Partial<RecordingRow> = {}): RecordingRow {
  // RecordingRow is a subset of RecordingDetail — the same default shape is
  // structurally valid here, so we reuse makeRecordingDetail and strip the
  // detail-only fields Dashboard never touches.
  const d = makeRecordingDetail(overrides);
  const row: RecordingRow = {
    id: d.id,
    filename: d.filename,
    startTime: d.startTime,
    endTime: d.endTime,
    durationMs: d.durationMs,
    filesizeBytes: d.filesizeBytes,
    serialNumber: d.serialNumber,
    folder: d.folder,
    audioPath: d.audioPath,
    transcriptPath: d.transcriptPath,
    summaryPath: d.summaryPath,
    metadataPath: d.metadataPath,
    audioDownloadedAt: d.audioDownloadedAt,
    transcriptDownloadedAt: d.transcriptDownloadedAt,
    webhookAudioFiredAt: d.webhookAudioFiredAt,
    webhookTranscriptFiredAt: d.webhookTranscriptFiredAt,
    isTrash: d.isTrash,
    isHistorical: d.isHistorical,
    lastError: d.lastError,
    status: d.status,
    inboxStatus: d.inboxStatus,
    effectiveInboxStatus: d.effectiveInboxStatus,
    category: d.category,
    snoozedUntil: d.snoozedUntil,
    reviewedAt: d.reviewedAt,
    tags: d.tags,
  };
  return row;
}

function listResponse(
  items: RecordingRow[],
  extras: Partial<Omit<RecordingsListResponse, "items">> = {},
): RecordingsListResponse {
  return {
    total: items.length,
    items,
    totalBytes: items.reduce((a, r) => a + r.filesizeBytes, 0),
    availableTags: [],
    availableCategories: [],
    ...extras,
  };
}

// Route the two Dashboard queries by URL. The `facets` query has `facets=1`
// in the query string; the main list doesn't. A single mockImplementation
// switch keeps per-test setup small.
function routeDashboardFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    list?: RecordingsListResponse | (() => Promise<RecordingsListResponse>);
    facets?: RecordingsListResponse;
    listError?: boolean;
    listPending?: boolean;
    syncOk?: boolean;
  } = {},
): void {
  const list = opts.list ?? listResponse([]);
  const facets = opts.facets ?? listResponse([]);
  stub.fetch.mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/sync/trigger")) {
      return Promise.resolve(
        jsonResponse({ ok: opts.syncOk ?? true }),
      );
    }
    if (url.includes("facets=1")) {
      return Promise.resolve(jsonResponse(facets));
    }
    if (url.startsWith("/api/recordings")) {
      if (opts.listPending) return new Promise(() => undefined);
      if (opts.listError) {
        return Promise.resolve(
          new Response("boom", { status: 500 }),
        );
      }
      const body = typeof list === "function" ? list() : list;
      return Promise.resolve(
        body instanceof Promise
          ? body.then((b) => jsonResponse(b))
          : jsonResponse(body),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("Dashboard — states", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows a loading indicator while the first list response is pending", () => {
    routeDashboardFetch(stub, { listPending: true });
    renderWithProviders(<Dashboard />);
    expect(screen.getByText(/^loading…$/i)).toBeInTheDocument();
  });

  it("renders an error message when the list query fails", async () => {
    routeDashboardFetch(stub, { listError: true });
    renderWithProviders(<Dashboard />);
    expect(
      await screen.findByText(/failed to load recordings/i),
    ).toBeInTheDocument();
  });

  it("renders the pristine empty state when no recordings exist and no filters are active", async () => {
    routeDashboardFetch(stub, { list: listResponse([]) });
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText(/no recordings yet/i)).toBeInTheDocument();
    // Pristine hint — points the user at "Sync now". The header button uses
    // "Sync Now" (title case), the hint uses "Sync now" (sentence case); match
    // case-sensitively so we only hit the hint span, not the button label.
    expect(screen.getByText("Sync now")).toBeInTheDocument();
  });

  it("renders the filtered empty state with the 'clear a filter' hint when filters are active", async () => {
    routeDashboardFetch(stub, { list: listResponse([]) });
    renderWithProviders(<Dashboard />, {
      routerEntries: ["/?filter=reviewed"],
    });
    expect(
      await screen.findByText(/no recordings match these filters/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/try clearing a filter or switching to the all view/i),
    ).toBeInTheDocument();
  });
});

describe("Dashboard — rendering recordings", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders a row per recording with filename, duration, size, and link to the detail page", async () => {
    const row = makeRow({
      id: "rec-42",
      filename: "standup-2026-04-18.ogg",
      startTime: new Date("2026-04-18T10:00:00Z").getTime(),
      durationMs: 2 * 60 * 1000 + 30 * 1000,
      filesizeBytes: 1.5 * 1024 * 1024,
      audioDownloadedAt: 123,
      transcriptDownloadedAt: 456,
      summaryPath: "s.md",
    });
    routeDashboardFetch(stub, { list: listResponse([row]) });
    renderWithProviders(<Dashboard />);

    expect(
      await screen.findByRole("heading", { name: /standup-2026-04-18/i }),
    ).toBeInTheDocument();
    // The whole card is a <Link> to /recordings/:id.
    const card = screen.getByRole("link", {
      name: /standup-2026-04-18\.ogg/i,
    });
    expect(card).toHaveAttribute("href", "/recordings/rec-42");
    // Duration formatted as m:ss.
    expect(within(card).getByText("2:30")).toBeInTheDocument();
    // MB rendered to one decimal.
    expect(within(card).getByText(/1\.5 MB/)).toBeInTheDocument();
  });

  it("renders the total count and total bytes in the page header", async () => {
    const rows = [
      makeRow({ id: "a", filesizeBytes: 512 * 1024 }),
      makeRow({ id: "b", filesizeBytes: 512 * 1024 }),
    ];
    routeDashboardFetch(stub, {
      list: listResponse(rows, { total: 17 }),
    });
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText(/17 matching/i)).toBeInTheDocument();
    // 1024 KB → 1.0 MB
    expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument();
  });

  it("renders the category + tag chips when present", async () => {
    const row = makeRow({
      id: "rec-1",
      category: "work",
      tags: ["urgent", "followup"],
    });
    routeDashboardFetch(stub, { list: listResponse([row]) });
    renderWithProviders(<Dashboard />);
    const card = await screen.findByRole("link");
    expect(within(card).getByText("work")).toBeInTheDocument();
    expect(within(card).getByText("urgent")).toBeInTheDocument();
    expect(within(card).getByText("followup")).toBeInTheDocument();
  });

  it("adds a snoozed-until indicator on rows with effectiveInboxStatus='snoozed'", async () => {
    const snoozedUntil = new Date("2026-05-01T14:30:00Z").getTime();
    const row = makeRow({
      id: "rec-1",
      effectiveInboxStatus: "snoozed",
      inboxStatus: "new",
      snoozedUntil,
    });
    routeDashboardFetch(stub, { list: listResponse([row]) });
    renderWithProviders(<Dashboard />);
    const card = await screen.findByRole("link");
    expect(within(card).getByText(/^Until /)).toBeInTheDocument();
    // Class reflects the dimmed treatment.
    expect(card.className).toMatch(/opacity-60/);
  });

  it("formats durations over an hour as h:mm:ss", async () => {
    const row = makeRow({
      id: "rec-1",
      // 1h 2m 3s
      durationMs: (1 * 3600 + 2 * 60 + 3) * 1000,
    });
    routeDashboardFetch(stub, { list: listResponse([row]) });
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText("1:02:03")).toBeInTheDocument();
  });
});

describe("Dashboard — deep-linking via URL search params", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("forwards filter/tag/category URL params into the listRecordings query string (trimmed)", async () => {
    routeDashboardFetch(stub, { list: listResponse([]) });
    renderWithProviders(<Dashboard />, {
      // Intentional leading/trailing whitespace — Dashboard trims to match
      // server-side behavior so the cache key doesn't fragment.
      routerEntries: ["/?filter=reviewed&tag=%20urgent%20&category=work"],
    });
    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(([input]) => {
          const url = typeof input === "string" ? input : String(input);
          return (
            url.startsWith("/api/recordings") &&
            !url.includes("facets=1") &&
            url.includes("filter=reviewed") &&
            url.includes("tag=urgent") && // trimmed
            url.includes("category=work")
          );
        }),
      ).toBe(true);
    });
  });

  it("omits filter/tag/category from the list query when unset (URL with no params)", async () => {
    routeDashboardFetch(stub, { list: listResponse([]) });
    renderWithProviders(<Dashboard />);
    // Wait for the list call to appear, THEN do the attribute-style
    // assertions outside the waitFor callback — lint forbids multiple
    // assertions inside waitFor because a mid-callback failure masks the
    // real cause.
    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(([input]) => {
          const url = typeof input === "string" ? input : String(input);
          return (
            url.startsWith("/api/recordings") && !url.includes("facets=1")
          );
        }),
      ).toBe(true);
    });
    const listCall = stub.fetch.mock.calls
      .map(([input]) => (typeof input === "string" ? input : String(input)))
      .find(
        (url) =>
          url.startsWith("/api/recordings") && !url.includes("facets=1"),
      );
    expect(listCall).toBeDefined();
    expect(listCall).not.toContain("filter=");
    expect(listCall).not.toContain("tag=");
    expect(listCall).not.toContain("category=");
    // Default limit is always sent.
    expect(listCall).toContain("limit=200");
  });

  it("also fires a facets query with facets=1 + limit=1 on mount", async () => {
    routeDashboardFetch(stub, {
      list: listResponse([]),
      facets: listResponse([], {
        availableTags: ["a", "b"],
        availableCategories: ["c"],
      }),
    });
    renderWithProviders(<Dashboard />);
    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(([input]) => {
          const url = typeof input === "string" ? input : String(input);
          return (
            url.startsWith("/api/recordings") &&
            url.includes("facets=1") &&
            url.includes("limit=1")
          );
        }),
      ).toBe(true);
    });
  });
});

describe("Dashboard — search + Sync Now", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("typing into the search box refetches with the trimmed search param", async () => {
    const user = userEvent.setup();
    routeDashboardFetch(stub, { list: listResponse([]) });
    renderWithProviders(<Dashboard />);
    // Wait for initial list fetch.
    await waitFor(() =>
      expect(
        stub.fetch.mock.calls.some(([i]) =>
          String(i).startsWith("/api/recordings"),
        ),
      ).toBe(true),
    );

    const input = screen.getByPlaceholderText(/search archives/i);
    await user.type(input, "standup");

    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(([i]) =>
          String(i).includes("search=standup"),
        ),
      ).toBe(true);
    });
  });

  it("clicking Sync Now hits /api/sync/trigger and disables the button while pending", async () => {
    const user = userEvent.setup();
    // Express the resolver as an external Deferred-like handle so TypeScript
    // keeps the callable type across the closure boundary (narrowing a
    // `() => void | null` local back to `() => void` is awkward without
    // a non-null assertion; this is the same pattern without the !).
    let resolveSync: (value: Response) => void = () => undefined;
    stub.fetch.mockImplementation((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/sync/trigger")) {
        // Hold the sync response open so we can observe the "Syncing…" state.
        return new Promise<Response>((r) => {
          resolveSync = r;
        });
      }
      return Promise.resolve(jsonResponse(listResponse([])));
    });

    renderWithProviders(<Dashboard />);
    const btn = await screen.findByRole("button", { name: /sync now/i });
    await user.click(btn);

    await screen.findByRole("button", { name: /syncing…/i });
    expect(screen.getByRole("button", { name: /syncing…/i })).toBeDisabled();

    // Release sync, verify button flips back.
    resolveSync(jsonResponse({ ok: true }));
    await screen.findByRole("button", { name: /sync now/i });
  });
});
