import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { SyncStatusBadge } from "./SyncStatusBadge.js";
import {
  jsonResponse,
  renderWithProviders,
  stubFetch,
} from "../test-utils.js";
import { syncStatusResponseFactory } from "../test-factories/index.js";

// Minimal EventSource stub — happy-dom doesn't ship a functional one, and we
// don't want to actually connect to /api/sync/events from a unit test. The
// component only reads .onmessage / .onerror / .close(); we don't need to
// implement the full DOM interface.
interface StubEventSource {
  url: string;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  close: () => void;
}

let lastEventSource: StubEventSource | null = null;

beforeEach(() => {
  lastEventSource = null;
  // `new EventSource(url)` requires a constructor, so use a class shape
  // instead of a bare vi.fn(). The class records the constructed instance
  // in a module-level ref so tests can inspect + trigger cleanup.
  class FakeEventSource implements StubEventSource {
    public onmessage: ((e: MessageEvent) => void) | null = null;
    public onerror: ((e: Event) => void) | null = null;
    public readonly close = vi.fn();
    // Arrow-function "constructor equivalent" fires on every `new` call;
    // using an initializer field sidesteps the @typescript-eslint/no-this-alias
    // complaint about `const x = this` inside a real constructor.
    public readonly _capture = ((): void => {
      lastEventSource = this as StubEventSource;
    })();
    constructor(public readonly url: string) {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SyncStatusBadge", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => {
    stub.cleanup();
  });

  it("renders a 'loading' placeholder before the first status response lands", () => {
    // Never resolve the first fetch so the useQuery stays in its loading state.
    stub.fetch.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<SyncStatusBadge />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("surfaces 'auth required' when status.authRequired is true", async () => {
    // Use mockImplementation so each refetch (10s interval + SSE invalidation)
    // gets a FRESH Response. Response bodies are single-use — reusing one
    // mockResolvedValue instance causes the second .json() read to throw.
    stub.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(syncStatusResponseFactory.authRequired().build()),
      ),
    );
    renderWithProviders(<SyncStatusBadge />);
    expect(await screen.findByText(/auth required/i)).toBeInTheDocument();
  });

  it("renders the 'syncing' badge when polling=true", async () => {
    stub.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(syncStatusResponseFactory.polling().build()),
      ),
    );
    renderWithProviders(<SyncStatusBadge />);
    expect(await screen.findByText(/syncing/i)).toBeInTheDocument();
  });

  it("renders the 'error' badge when lastError is set and not currently polling", async () => {
    stub.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          syncStatusResponseFactory
            .withLastPoll(100)
            .withError("boom")
            .withErrorsLast24h(1)
            .build(),
        ),
      ),
    );
    renderWithProviders(<SyncStatusBadge />);
    expect(await screen.findByText(/^error$/i)).toBeInTheDocument();
  });

  it("renders the 'synced …' badge with a relative timestamp on a clean status", async () => {
    stub.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(
          syncStatusResponseFactory.withLastPoll(Date.now() - 5_000).build(),
        ),
      ),
    );
    renderWithProviders(<SyncStatusBadge />);
    // "5s ago" / "just now" / etc. — we just assert the "synced" prefix to
    // avoid pinning the exact relative-time string under test-clock jitter.
    expect(await screen.findByText(/^synced /i)).toBeInTheDocument();
  });

  it.each([
    { secs: 30, matcher: /synced \d+s ago/i, label: "30s → Xs ago" },
    { secs: 5 * 60, matcher: /synced 5m ago/i, label: "5m → Xm ago" },
    { secs: 2 * 3600, matcher: /synced 2h ago/i, label: "2h → Xh ago" },
  ])(
    "formatRelative: $label",
    async ({ secs, matcher }) => {
      // Each branch of formatRelative (just now / Xs / Xm / Xh) needs a
      // dedicated lastPollAt — the default 'synced' test above only exercises
      // the 'just now' branch (< 10s).
      stub.fetch.mockImplementation(() =>
        Promise.resolve(
          jsonResponse(
            syncStatusResponseFactory
              .withLastPoll(Date.now() - secs * 1000)
              .build(),
          ),
        ),
      );
      renderWithProviders(<SyncStatusBadge />);
      expect(await screen.findByText(matcher)).toBeInTheDocument();
    },
  );

  it("an SSE message triggers react-query invalidation for sync-status + recordings", async () => {
    // Covers the onmessage handler body (SyncStatusBadge.tsx:32-33) which
    // previous tests only exercised the onerror / mount / unmount paths of.
    stub.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(syncStatusResponseFactory.withLastPoll(100).build()),
      ),
    );
    renderWithProviders(<SyncStatusBadge />);
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    const before = stub.fetch.mock.calls.length;
    lastEventSource!.onmessage?.(new MessageEvent("message", { data: "{}" }));
    // invalidateQueries triggers a re-fetch for BOTH keys; at least one fresh
    // fetch call should land shortly after the SSE message arrives.
    await waitFor(() =>
      expect(stub.fetch.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("an SSE error closes the stream (onerror handler)", async () => {
    // Distinct from the unmount test — triggered by the EventSource errorring
    // out (e.g. server restart) rather than React tearing the component down.
    stub.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(syncStatusResponseFactory.withLastPoll(100).build()),
      ),
    );
    renderWithProviders(<SyncStatusBadge />);
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    lastEventSource!.onerror?.(new Event("error"));
    expect(lastEventSource!.close).toHaveBeenCalled();
  });

  it("opens an EventSource to /api/sync/events on mount and closes it on unmount", async () => {
    stub.fetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(syncStatusResponseFactory.withLastPoll(100).build()),
      ),
    );
    const { unmount } = renderWithProviders(<SyncStatusBadge />);

    await waitFor(() => expect(lastEventSource).not.toBeNull());
    expect(lastEventSource!.url).toBe("/api/sync/events");

    unmount();
    expect(lastEventSource!.close).toHaveBeenCalled();
  });
});
