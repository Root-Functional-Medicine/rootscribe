import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { SetupWizard } from "./SetupWizard.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../../test-utils.js";

// SetupWizard is a linear state machine over a union of step names. We
// exercise its orchestration (progress %, step activation, navigation
// between steps, finish flow) without deeply re-testing each step's
// internals — those are covered by the per-step test files.
//
// The wizard mounts multiple children that fire queries on mount: AuthStep
// calls /api/auth/detect; JiraStep calls /api/config; ReviewStep calls
// /api/config. All must be stubbed via a single fetch router.

// Minimal EventSource stub so AuthStep's "watch" button won't crash if
// accidentally clicked in a navigation test. The wizard tests don't exercise
// the watch flow — AuthStep has its own file for that.
function installEventSourceStub(): void {
  class FakeEventSource {
    public onmessage: ((e: MessageEvent) => void) | null = null;
    public onerror: ((e: Event) => void) | null = null;
    public close = vi.fn();
    constructor(public readonly url: string) {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);
}

// Route every wizard-relevant endpoint to a sensible default. Each test
// patches the relevant behavior via `overrides`.
function routeWizardFetch(
  stub: ReturnType<typeof stubFetch>,
  overrides: Partial<
    Record<
      | "/api/auth/detect"
      | "/api/auth/accept"
      | "/api/auth/watch"
      | "/api/config"
      | "/api/config/validate-recordings-dir"
      | "/api/config/test-webhook"
      | "/api/config/complete-setup",
      unknown
    >
  > = {},
): void {
  stub.fetch.mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    for (const [path, body] of Object.entries(overrides)) {
      if (url.includes(path)) {
        return Promise.resolve(jsonResponse(body));
      }
    }

    if (url === "/api/config" && method === "GET") {
      return Promise.resolve(
        jsonResponse({
          config: {
            setupComplete: false,
            token: "tok",
            tokenExp: null,
            tokenEmail: "alice@example.com",
            plaudRegion: null,
            recordingsDir: "/srv/recordings",
            webhook: null,
            pollIntervalMinutes: 10,
            bind: { host: "127.0.0.1", port: 44471 },
            lanToken: null,
            jiraBaseUrl: "https://acme.atlassian.net/browse/",
          },
        }),
      );
    }
    if (url === "/api/config" && method === "POST") {
      return Promise.resolve(jsonResponse({ config: {} }));
    }
    if (url.includes("/api/auth/detect")) {
      // Default: no browser session found → AuthStep renders the "notfound"
      // UI (watch button + manual textarea).
      return Promise.resolve(jsonResponse({ found: false }));
    }
    if (url.includes("/api/auth/accept")) {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (url.includes("/api/config/validate-recordings-dir")) {
      return Promise.resolve(
        jsonResponse({
          ok: true,
          absolutePath: "/srv/recordings",
          freeBytes: 100 * 1024 ** 3,
        }),
      );
    }
    if (url.includes("/api/config/complete-setup")) {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

function renderWizard() {
  // Wrap in <Routes> so useNavigate resolves to a real route tree — after
  // finish(), the wizard pushes to "/". Matching that with a visible
  // location-shower lets us assert navigation happened.
  return renderWithProviders(
    <Routes>
      <Route path="/setup/*" element={<SetupWizard />} />
      <Route path="/" element={<div data-testid="post-setup-home">home</div>} />
    </Routes>,
    { routerEntries: ["/setup"] },
  );
}

describe("SetupWizard — header + progress", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    installEventSourceStub();
    routeWizardFetch(stub);
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the RootScribe brand + 'Setup Wizard' label", () => {
    renderWizard();
    // "Setup Wizard • 17%" is unique enough to match case-insensitively.
    expect(screen.getByText(/setup wizard/i)).toBeInTheDocument();
    // "RootScribe" appears in the brand span + in the WelcomeStep heading,
    // so there are multiple matches — getAllByText + non-empty assertion.
    expect(screen.getAllByText(/rootscribe/i).length).toBeGreaterThan(0);
  });

  it("progress starts at 17% (step 1 of 6) on Welcome", () => {
    renderWizard();
    expect(screen.getByText(/17%/)).toBeInTheDocument();
  });

  it("renders all six step labels in order: Welcome, Auth, Folder, Webhook, Jira, Review", () => {
    renderWizard();
    for (const label of ["Welcome", "Auth", "Folder", "Webhook", "Jira", "Review"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe("SetupWizard — step navigation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    installEventSourceStub();
    routeWizardFetch(stub);
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("Start on Welcome advances to Auth (progress 33%)", async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(screen.getByText(/welcome to rootscribe/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(
      await screen.findByText(/connect your plaud account/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/33%/)).toBeInTheDocument();
  });

  it("Back on a later step restores the prior step", async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole("button", { name: /start/i }));
    await screen.findByText(/connect your plaud account/i);

    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(
      await screen.findByText(/welcome to rootscribe/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/17%/)).toBeInTheDocument();
  });
});

describe("SetupWizard — finish flow", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    installEventSourceStub();
    routeWizardFetch(stub);
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("finish() POSTs /api/config/complete-setup and navigates to '/'", async () => {
    const user = userEvent.setup();
    renderWizard();
    // Walk to Review by simulating forward navigation through each step's
    // internal state. This is a pragmatic shortcut: wiring all five
    // intermediate interactions (which are exercised by their own test
    // files) would make this test about the whole system rather than the
    // orchestrator. Bypass with a keyboard: hit the Start button, then for
    // later steps we rely on the state-machine API via the rendered
    // orchestrator.
    // Step 1 → 2
    await user.click(screen.getByRole("button", { name: /start/i }));
    await screen.findByText(/connect your plaud account/i);
    // Skip Auth manually by submitting a dummy token; detect returns
    // "notfound", then we expand the "Paste a token manually" <details>
    // (hidden by default in a real browser) before typing + submitting.
    await user.click(
      await screen.findByText(/paste a token manually/i),
    );
    const tokenInput = await screen.findByPlaceholderText(/bearer eyJ/i);
    await user.type(
      tokenInput,
      "bearer eyJhbGciOiJ000000000000000000",
    );
    await user.click(screen.getByRole("button", { name: /use this token/i }));

    // Step 3: RecordingsDir — Check, then Next.
    await screen.findByText(/recordings folder/i);
    await user.click(screen.getByRole("button", { name: /^check$/i }));
    await screen.findByText(/directory valid/i);
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    // Step 4: Webhook — Skip.
    await screen.findByText(/webhook configuration/i);
    await user.click(screen.getByRole("button", { name: /^skip$/i }));

    // Step 5: Jira — Next.
    await screen.findByText(/jira integration/i);
    const jiraNext = await screen.findByRole("button", {
      name: /^next$/i,
    });
    await user.click(jiraNext);

    // Step 6: Review — click Save & start syncing.
    await screen.findByText(/review & launch/i);
    await user.click(
      screen.getByRole("button", { name: /save & start syncing/i }),
    );

    // /api/config/complete-setup hit + navigation to "/" resolves.
    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(([i]) =>
          String(i).includes("/api/config/complete-setup"),
        ),
      ).toBe(true);
    });
    expect(
      await screen.findByTestId("post-setup-home"),
    ).toBeInTheDocument();
  });
});
