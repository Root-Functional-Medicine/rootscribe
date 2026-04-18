import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell.js";
import { TestProviders, jsonResponse, stubFetch } from "../test-utils.js";

// Stub the EventSource ctor that SyncStatusBadge opens on mount. We don't
// care what it does for these tests, just that constructing doesn't throw.
class FakeEventSource {
  public onmessage: ((e: MessageEvent) => void) | null = null;
  public onerror: ((e: Event) => void) | null = null;
  public close = vi.fn();
  constructor(public readonly url: string) {}
}

function renderShell(initialPath = "/"): ReturnType<typeof render> {
  return render(
    <TestProviders routerEntries={[initialPath]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<main data-testid="dashboard-outlet">DASH</main>} />
          <Route
            path="/settings"
            element={<main data-testid="settings-outlet">SETTINGS</main>}
          />
        </Route>
      </Routes>
    </TestProviders>,
  );
}

describe("AppShell — layout and navigation", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
    stub.fetch.mockResolvedValue(
      jsonResponse({
        lastPollAt: null,
        nextPollAt: null,
        polling: false,
        pendingTranscripts: 0,
        errorsLast24h: 0,
        lastError: null,
        authRequired: false,
      }),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    localStorage.clear();
  });

  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders the RootScribe brand, nav links, and child outlet content", () => {
    renderShell("/");
    // Brand + Recordings both link to '/'; the brand is identifiable by its
    // distinctive "RootScribe" text, so filter by name substring to pick it.
    const brand = screen
      .getAllByRole("link")
      .find((el) => /rootscribe/i.test(el.textContent ?? ""));
    expect(brand).toBeDefined();
    expect(screen.getAllByRole("link", { name: /recordings/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-outlet")).toBeInTheDocument();
  });

  it("renders the Settings outlet when routed to /settings", () => {
    renderShell("/settings");
    expect(screen.getByTestId("settings-outlet")).toBeInTheDocument();
  });

  it("includes the GitHub star link with target=_blank + rel noopener", () => {
    renderShell("/");
    const gh = screen.getByRole("link", { name: /view on github/i });
    expect(gh).toHaveAttribute("target", "_blank");
    expect(gh).toHaveAttribute("rel", "noopener noreferrer");
    expect(gh).toHaveAttribute(
      "href",
      "https://github.com/Root-Functional-Medicine/rootscribe",
    );
  });
});

describe("AppShell — GitHub star nudge", () => {
  let stub: ReturnType<typeof stubFetch>;

  beforeEach(() => {
    stub = stubFetch();
    stub.fetch.mockResolvedValue(
      jsonResponse({
        lastPollAt: null,
        nextPollAt: null,
        polling: false,
        pendingTranscripts: 0,
        errorsLast24h: 0,
        lastError: null,
        authRequired: false,
      }),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    localStorage.clear();
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("does NOT show the nudge on the first dashboard visit", () => {
    renderShell("/");
    expect(screen.queryByText(/star on github/i)).not.toBeInTheDocument();
    // Visit counter bumped to 1.
    expect(localStorage.getItem("rootscribe-dashboard-visits")).toBe("1");
  });

  it("shows the nudge on exactly the 3rd dashboard visit", () => {
    localStorage.setItem("rootscribe-dashboard-visits", "2");
    renderShell("/");
    expect(screen.getByText(/star on github/i)).toBeInTheDocument();
  });

  it("does not show the nudge on non-dashboard routes even if visits>=3", () => {
    localStorage.setItem("rootscribe-dashboard-visits", "5");
    renderShell("/settings");
    expect(screen.queryByText(/star on github/i)).not.toBeInTheDocument();
  });

  it("does not show the nudge after the user has dismissed it (persisted flag)", () => {
    localStorage.setItem("rootscribe-dashboard-visits", "2");
    localStorage.setItem("rootscribe-star-dismissed", "1");
    renderShell("/");
    expect(screen.queryByText(/star on github/i)).not.toBeInTheDocument();
  });

  it("Dismiss persists the rootscribe-star-dismissed flag and hides the nudge immediately", async () => {
    localStorage.setItem("rootscribe-dashboard-visits", "2");
    const user = userEvent.setup();
    renderShell("/");

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/star on github/i)).not.toBeInTheDocument();
    expect(localStorage.getItem("rootscribe-star-dismissed")).toBe("1");
  });
});
