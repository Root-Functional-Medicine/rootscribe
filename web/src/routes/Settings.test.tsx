import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AppConfig,
  SyncStatusResponse,
  WebhookTestResponse,
} from "@rootscribe/shared";
import { DEFAULT_CONFIG } from "@rootscribe/shared";
import { Settings } from "./Settings.js";
import { createTestQueryClient, jsonResponse, renderWithProviders, stubFetch } from "../test-utils.js";
import {
  appConfigFactory,
  syncStatusResponseFactory,
} from "../test-factories/index.js";

// Settings composes two queries (config + sync-status, the latter on a 5s
// interval) and three actions (webhook test, config save, implicit refetch
// via cache invalidation). Every test hits the real jsonFetch → fetch
// pipeline through a stubbed global.fetch.

// Settings is always shown post-setup, so the factory's `.setupComplete()`
// trait captures the right starting state. Token expiry is ~90 days out —
// enough that the "Expires in" copy doesn't flicker during test runs.
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return appConfigFactory
    .setupComplete()
    .build({
      tokenExp: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
      ...overrides,
    });
}

// Normal, healthy sync state — last poll 30s ago, nothing pending, no errors.
// Per-test overrides (polling, authRequired, lastError) go through factory
// traits at call sites.
function syncStatus(
  overrides: Partial<SyncStatusResponse> = {},
): SyncStatusResponse {
  return syncStatusResponseFactory.build({
    lastPollAt: Date.now() - 30_000,
    nextPollAt: Date.now() + 30_000,
    ...overrides,
  });
}

// Route all three endpoints this page touches. fetch → config/syncStatus/
// test-webhook all share one switch so per-test overrides are one-liners.
function routeSettingsFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    config?: AppConfig;
    configPending?: boolean;
    // Fail the GET /api/config request so useQuery ends in an error state
    // and the Settings page renders its "failed to load" fallback.
    configFailed?: boolean;
    sync?: SyncStatusResponse;
    configPostError?: { status: number; body: unknown };
    configPostResult?: AppConfig;
    testWebhook?: WebhookTestResponse;
  } = {},
): void {
  stub.fetch.mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/config" && method === "GET") {
      if (opts.configPending) return new Promise(() => undefined);
      if (opts.configFailed) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({ config: opts.config ?? makeConfig() }),
      );
    }
    if (url === "/api/config" && method === "POST") {
      if (opts.configPostError) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: opts.configPostError.body }), {
            status: opts.configPostError.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({ config: opts.configPostResult ?? opts.config ?? makeConfig() }),
      );
    }
    if (url === "/api/config/test-webhook") {
      return Promise.resolve(
        jsonResponse(
          opts.testWebhook ?? {
            ok: true,
            statusCode: 200,
            bodySnippet: "pong",
            durationMs: 42,
          },
        ),
      );
    }
    if (url === "/api/sync/status") {
      return Promise.resolve(jsonResponse(opts.sync ?? syncStatus()));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("Settings — initial state", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows the loading indicator while config is pending", () => {
    routeSettingsFetch(stub, { configPending: true });
    renderWithProviders(<Settings />);
    expect(screen.getByText(/^loading…$/i)).toBeInTheDocument();
  });

  it("renders the 'failed to load' fallback when the config query errors out", async () => {
    routeSettingsFetch(stub, { configFailed: true });
    renderWithProviders(<Settings />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it("populates the form from the loaded config (webhook, poll interval, jira URL)", async () => {
    const cfg = makeConfig({
      webhook: { url: "https://hook.example/v1/ingest", enabled: true },
      pollIntervalMinutes: 15,
      jiraBaseUrl: "https://example.atlassian.net/browse/",
    });
    routeSettingsFetch(stub, { config: cfg });
    renderWithProviders(<Settings />);

    const webhookInput = await screen.findByPlaceholderText(
      /api\.yourdomain\.com/i,
    );
    expect(webhookInput).toHaveValue("https://hook.example/v1/ingest");
    // Poll interval shown as a big number; the slider carries the live value.
    expect(screen.getByRole("slider")).toHaveValue("15");
    expect(
      screen.getByDisplayValue("https://example.atlassian.net/browse/"),
    ).toBeInTheDocument();
  });

  it("displays the token email + days-until-expiration + recordings dir", async () => {
    // 10 days from now → "Expires in 10 days"
    const tenDays = Math.floor((Date.now() + 10 * 24 * 3600 * 1000) / 1000);
    const cfg = makeConfig({
      tokenEmail: "alice@example.com",
      tokenExp: tenDays,
      recordingsDir: "/srv/recordings",
    });
    routeSettingsFetch(stub, { config: cfg });
    renderWithProviders(<Settings />);
    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText(/expires in 10 days/i)).toBeInTheDocument();
    expect(screen.getByText("/srv/recordings")).toBeInTheDocument();
  });
});

describe("Settings — sync status panel", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows 'All systems operational' when status is healthy", async () => {
    routeSettingsFetch(stub, { sync: syncStatus() });
    renderWithProviders(<Settings />);
    expect(
      await screen.findByText(/all systems operational/i),
    ).toBeInTheDocument();
  });

  it("shows 'Auth required' when the server reports authRequired", async () => {
    routeSettingsFetch(stub, {
      sync: syncStatus({ authRequired: true }),
    });
    renderWithProviders(<Settings />);
    expect(await screen.findByText(/auth required/i)).toBeInTheDocument();
  });

  it("shows 'Error detected' when a lastError is present", async () => {
    routeSettingsFetch(stub, {
      sync: syncStatus({ lastError: "connection reset" }),
    });
    renderWithProviders(<Settings />);
    expect(await screen.findByText(/error detected/i)).toBeInTheDocument();
  });

  it("pluralizes 'pending transcripts' correctly", async () => {
    routeSettingsFetch(stub, { sync: syncStatus({ pendingTranscripts: 3 }) });
    const { unmount } = renderWithProviders(<Settings />);
    expect(await screen.findByText(/3 transcripts/i)).toBeInTheDocument();
    unmount();

    // Singular form.
    stub.cleanup();
    stub = stubFetch();
    routeSettingsFetch(stub, { sync: syncStatus({ pendingTranscripts: 1 }) });
    renderWithProviders(<Settings />);
    expect(await screen.findByText(/1 transcript\b/i)).toBeInTheDocument();
  });
});

describe("Settings — webhook URL + test", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("Test button is disabled until the user enters a webhook URL", async () => {
    routeSettingsFetch(stub, { config: makeConfig({ webhook: null }) });
    renderWithProviders(<Settings />);
    const testBtn = await screen.findByRole("button", { name: /^test$/i });
    expect(testBtn).toBeDisabled();
    await userEvent.setup().type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    expect(testBtn).not.toBeDisabled();
  });

  it("shows 'Connection Success' and HTTP status after a successful test", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true },
      }),
      testWebhook: {
        ok: true,
        statusCode: 204,
        bodySnippet: "ok",
        durationMs: 10,
      },
    });
    renderWithProviders(<Settings />);
    await user.click(await screen.findByRole("button", { name: /^test$/i }));
    expect(
      await screen.findByText(/connection success/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/HTTP 204 — ok/i)).toBeInTheDocument();
  });

  it("shows 'Connection Failed' with the server-supplied error message on a failed test", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://bad.example", enabled: true },
      }),
      testWebhook: {
        ok: false,
        statusCode: 500,
        bodySnippet: "internal error",
        error: "HTTP 500",
        durationMs: 10,
      },
    });
    renderWithProviders(<Settings />);
    await user.click(await screen.findByRole("button", { name: /^test$/i }));
    expect(
      await screen.findByText(/connection failed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/HTTP 500 — internal error/i),
    ).toBeInTheDocument();
  });
});

describe("Settings — save button", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("is disabled until the user edits a field (initial state is clean)", async () => {
    routeSettingsFetch(stub, { config: makeConfig() });
    renderWithProviders(<Settings />);
    const saveBtn = await screen.findByRole("button", {
      name: /save settings/i,
    });
    expect(saveBtn).toBeDisabled();
  });

  it("enables the save button after editing the webhook URL", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, { config: makeConfig({ webhook: null }) });
    renderWithProviders(<Settings />);
    const webhookInput = await screen.findByPlaceholderText(
      /api\.yourdomain\.com/i,
    );
    await user.type(webhookInput, "https://hook.example");
    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    expect(saveBtn).not.toBeDisabled();
  });

  it("POSTs updated config with trimmed webhook URL, trimmed jira URL, and current poll minutes", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({ webhook: null, jiraBaseUrl: "" }),
    });
    renderWithProviders(<Settings />);
    const webhookInput = await screen.findByPlaceholderText(
      /api\.yourdomain\.com/i,
    );
    // Deliberate surrounding whitespace — Settings trims on save to keep the
    // server from seeing "  https://hook  " values.
    await user.type(webhookInput, "  https://hook.example  ");

    // Also edit the Jira URL with trailing whitespace so the trim path on
    // jiraBaseUrl is exercised in this assertion (Copilot called out that
    // without an edit here we were only verifying the DEFAULT fallback).
    const jiraInput = screen.getByPlaceholderText(DEFAULT_CONFIG.jiraBaseUrl);
    await user.type(jiraInput, "  https://myco.atlassian.net/browse/  ");

    // Only edited fields are sent (per-field touched tracking), so move the
    // slider too for the pollIntervalMinutes assertion below to apply.
    fireEvent.change(screen.getByRole("slider"), { target: { value: "12" } });

    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(
          ([i, init]) =>
            String(i) === "/api/config" &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
    const postCall = stub.fetch.mock.calls.find(
      ([i, init]) =>
        String(i) === "/api/config" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse(
      String((postCall?.[1] as RequestInit).body),
    ) as {
      webhook: { url: string; enabled: boolean };
      pollIntervalMinutes: number;
      jiraBaseUrl: string;
    };
    expect(body.webhook).toEqual({
      url: "https://hook.example",
      enabled: true,
    });
    expect(body.pollIntervalMinutes).toBe(12);
    // Trimmed Jira URL made it to the wire.
    expect(body.jiraBaseUrl).toBe("https://myco.atlassian.net/browse/");
  });

  it("falls back to DEFAULT_CONFIG.jiraBaseUrl when the user clears the Jira field", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({ webhook: null, jiraBaseUrl: "https://old.atlassian.net/browse/" }),
    });
    renderWithProviders(<Settings />);
    const jiraInput = await screen.findByPlaceholderText(DEFAULT_CONFIG.jiraBaseUrl);
    await user.clear(jiraInput);
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      expect(
        stub.fetch.mock.calls.some(
          ([i, init]) =>
            String(i) === "/api/config" &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
    const postCall = stub.fetch.mock.calls.find(
      ([i, init]) =>
        String(i) === "/api/config" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse(
      String((postCall?.[1] as RequestInit).body),
    ) as { jiraBaseUrl: string };
    // Blank Jira URL → default (preserves the "clear" gesture without
    // leaving the stored value dangling).
    expect(body.jiraBaseUrl).toBe(DEFAULT_CONFIG.jiraBaseUrl);
  });

  it("sends webhook=null when the webhook URL is cleared to empty", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://old", enabled: true },
      }),
    });
    renderWithProviders(<Settings />);
    const webhookInput = await screen.findByPlaceholderText(
      /api\.yourdomain\.com/i,
    );
    await user.clear(webhookInput);
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      const postCall = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      const body = JSON.parse(
        String((postCall?.[1] as RequestInit).body),
      ) as { webhook: unknown };
      expect(body.webhook).toBeNull();
    });
  });

  it("surfaces the server error message inline when save fails", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({ webhook: null }),
      configPostError: {
        status: 400,
        body: { fieldErrors: { jiraBaseUrl: ["must be https"] } },
      },
    });
    renderWithProviders(<Settings />);
    const webhookInput = await screen.findByPlaceholderText(
      /api\.yourdomain\.com/i,
    );
    await user.type(webhookInput, "https://hook.example");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    // ApiError carries the extracted message from the Zod-flatten body.
    expect(
      await screen.findByText(/jiraBaseUrl: must be https/i),
    ).toBeInTheDocument();
  });
});

describe("Settings — jira base URL preview", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows a live DEVX-96 preview that strips trailing slashes from the input", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({ jiraBaseUrl: "" }),
    });
    renderWithProviders(<Settings />);
    const input = await screen.findByPlaceholderText(
      DEFAULT_CONFIG.jiraBaseUrl,
    );
    await user.clear(input);
    await user.type(input, "https://myco.atlassian.net/browse///");
    // Preview normalizes trailing slashes. Match on "Preview:" context so we
    // hit the preview paragraph, not the help-text "e.g. DEVX-96" span.
    expect(screen.getByText(/^Preview:/i)).toBeInTheDocument();
    expect(
      screen.getByText(/myco\.atlassian\.net\/browse\/DEVX-96/),
    ).toBeInTheDocument();
  });

  it("does not render the preview paragraph when the Jira URL is blank", async () => {
    routeSettingsFetch(stub, { config: makeConfig({ jiraBaseUrl: "" }) });
    renderWithProviders(<Settings />);
    // Wait for the form to populate first.
    await screen.findByPlaceholderText(DEFAULT_CONFIG.jiraBaseUrl);
    // The "e.g. DEVX-96" help text is always present; only the "Preview:"
    // label disappears when the URL is empty. Match on that.
    expect(screen.queryByText(/^Preview:/i)).not.toBeInTheDocument();
  });
});

describe("Settings — formatRelative branches", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  // The Settings page runs a 5s refetch on /api/sync/status, so lastPollAt
  // threads through formatRelative on every render. Exercise every branch
  // by seeding varying `lastPollAt` values and reading the "Last poll" tile.
  //
  // `it.each` computes its input array when the test FILE is evaluated, not
  // when each test runs. A raw `Date.now() - 3_000` in the array would be
  // stale by the time this block ran — the "< 10s" case could drift past 10s
  // (becoming "Xs ago"), and the "< 60s" case could drift past 60s (becoming
  // "Xm ago") — making the regex assertions flaky. Store *offsets* instead
  // and resolve them to absolute timestamps inside the test body, where
  // Date.now() is fresh.
  const DAY = 24 * 3_600_000;
  it.each([
    { offsetMs: null as number | null, expected: /never/i, label: "null → never" },
    { offsetMs: 3_000, expected: /just now/i, label: "< 10s → just now" },
    { offsetMs: 30_000, expected: /\d+s ago/i, label: "< 60s → Xs ago" },
    { offsetMs: 5 * 60_000, expected: /5m ago/i, label: "< 1h → Xm ago" },
    { offsetMs: 2 * 3_600_000, expected: /2h ago/i, label: "≥ 1h → Xh ago" },
    { offsetMs: DAY, expected: /24h ago/i, label: "24h → Xh ago (no day cap)" },
  ])("renders $label", async ({ offsetMs, expected }) => {
    const lastPollAt = offsetMs == null ? null : Date.now() - offsetMs;
    routeSettingsFetch(stub, { sync: syncStatus({ lastPollAt }) });
    renderWithProviders(<Settings />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

describe("Settings — test-webhook error handling", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("surfaces err.message when api.testWebhook rejects with a native Error", async () => {
    const user = userEvent.setup();
    // Override fetch for test-webhook to reject — this escapes through the
    // catch in Settings.tsx's `test()` helper (`err instanceof Error` → true).
    stub.fetch.mockImplementation((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/config")
        return Promise.resolve(
          jsonResponse({
            config: makeConfig({
              webhook: { url: "https://hook.example", enabled: true },
            }),
          }),
        );
      if (url === "/api/config/test-webhook")
        return Promise.reject(new Error("network down"));
      if (url === "/api/sync/status")
        return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />);
    await user.click(await screen.findByRole("button", { name: /^test$/i }));
    expect(await screen.findByText(/connection failed/i)).toBeInTheDocument();
    expect(screen.getByText(/network down/i)).toBeInTheDocument();
  });

  it("surfaces String(err) when api.testWebhook rejects with a non-Error value", async () => {
    const user = userEvent.setup();
    stub.fetch.mockImplementation((input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "/api/config")
        return Promise.resolve(
          jsonResponse({
            config: makeConfig({
              webhook: { url: "https://hook.example", enabled: true },
            }),
          }),
        );
      if (url === "/api/config/test-webhook")
        return Promise.reject("string-thrown");
      if (url === "/api/sync/status")
        return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />);
    await user.click(await screen.findByRole("button", { name: /^test$/i }));
    expect(await screen.findByText(/connection failed/i)).toBeInTheDocument();
    expect(screen.getByText("string-thrown")).toBeInTheDocument();
  });

  it("falls back to the generic save-error message when err isn't an Error", async () => {
    const user = userEvent.setup();
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET")
        return Promise.resolve(jsonResponse({ config: makeConfig() }));
      if (url === "/api/config" && method === "POST")
        return Promise.reject("not-an-Error-instance");
      if (url === "/api/sync/status")
        return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />);
    const slider = await screen.findByRole("slider");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(slider, { target: { value: "30" } });
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    // Save catch: `err instanceof Error ? err.message : "Failed to save settings."`
    // For a non-Error throw, the right-hand branch fires and we see the
    // literal fallback string.
    expect(
      await screen.findByText(/failed to save settings/i),
    ).toBeInTheDocument();
  });
});

describe("Settings — poll interval slider", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("updates the displayed minutes value + marks the form dirty when dragged", async () => {
    routeSettingsFetch(stub, { config: makeConfig({ pollIntervalMinutes: 10 }) });
    renderWithProviders(<Settings />);
    const slider = await screen.findByRole("slider");
    // fireEvent.change is more reliable than user.type for <input type="range">
    // because user-event doesn't synthesize range-drag events.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(slider, { target: { value: "30" } });
    expect(slider).toHaveValue("30");
    expect(screen.getByText("30")).toBeInTheDocument();
    // Save button enabled after edit.
    expect(
      screen.getByRole("button", { name: /save settings/i }),
    ).not.toBeDisabled();
  });
});

describe("Settings — webhook signing secret + instance id", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  function findPost(url: string): Record<string, unknown> {
    const postCall = stub.fetch.mock.calls.find(
      ([i, init]) =>
        String(i) === url && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    return JSON.parse(String((postCall?.[1] as RequestInit).body)) as Record<string, unknown>;
  }

  // The server never returns the secret (GET /api/config redacts it and
  // reports `secretConfigured`), so the field is write-only: it starts
  // empty, tells the user whether one is stored, and an untouched field
  // means "keep what is stored" on save.
  it("shows the configured state without revealing the secret, and populates the instance id", async () => {
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true, secretConfigured: true },
        instanceId: "inst-from-disk",
      }),
    });
    renderWithProviders(<Settings />);

    const secretInput = await screen.findByLabelText(/signing secret/i);
    expect(secretInput).toHaveValue("");
    expect(secretInput).toHaveAttribute("placeholder", expect.stringMatching(/configured/i));
    expect(screen.getByRole("button", { name: /^clear$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/instance id/i)).toHaveValue("inst-from-disk");
  });

  it("offers no Clear button and an 'unsigned' hint when no secret is stored", async () => {
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true, secretConfigured: false },
      }),
    });
    renderWithProviders(<Settings />);
    const secretInput = await screen.findByLabelText(/signing secret/i);
    expect(secretInput).toHaveAttribute("placeholder", expect.stringMatching(/unsigned/i));
    expect(screen.queryByRole("button", { name: /^clear$/i })).not.toBeInTheDocument();
  });

  it("Generate fills the secret with 64 hex characters and marks the form dirty", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({ webhook: { url: "https://hook.example", enabled: true } }),
    });
    renderWithProviders(<Settings />);
    await screen.findByLabelText(/signing secret/i);
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /generate/i }));

    expect(
      (screen.getByLabelText(/signing secret/i) as HTMLInputElement).value,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.getByRole("button", { name: /save settings/i })).toBeEnabled();
  });

  it("save POSTs a typed secret inside the webhook object and the trimmed instance id", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true },
        instanceId: "inst-old",
      }),
    });
    renderWithProviders(<Settings />);

    await user.type(await screen.findByLabelText(/signing secret/i), "  whsec_typed  ");
    const instanceInput = screen.getByLabelText(/instance id/i);
    await user.clear(instanceInput);
    await user.type(instanceInput, "  allen-macbook  ");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      const body = findPost("/api/config");
      expect(body.webhook).toEqual({
        url: "https://hook.example",
        enabled: true,
        secret: "whsec_typed",
      });
      expect(body.instanceId).toBe("allen-macbook");
    });
  });

  it("omits `webhook` entirely when neither the URL nor the secret was edited (stored webhook + secret are kept); a blank instance id is omitted too", async () => {
    // Copilot review on PR #19 round 18 (suppressed finding): re-posting the
    // hydrated webhook on an unrelated save could send a stale cached value
    // (even null) over the server's current URL + secret. The server treats
    // an omitted `webhook` as "keep", so only send it when it was edited.
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true, secretConfigured: true },
        instanceId: "inst-keep",
      }),
    });
    renderWithProviders(<Settings />);

    // Edit something unrelated so Save is enabled, and blank the instance id.
    await user.clear(await screen.findByLabelText(/instance id/i));
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      const body = findPost("/api/config");
      expect(body).not.toHaveProperty("webhook");
      expect(body).not.toHaveProperty("instanceId");
      // Nothing else was edited either.
      expect(body).toEqual({});
    });
  });

  it("includes `webhook` when only the secret was edited (URL untouched)", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({ webhook: { url: "https://hook.example", enabled: true } }),
    });
    renderWithProviders(<Settings />);
    await user.type(await screen.findByLabelText(/signing secret/i), "new-secret");
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => {
      expect(findPost("/api/config").webhook).toEqual({
        url: "https://hook.example",
        enabled: true,
        secret: "new-secret",
      });
    });
  });

  it("any completed config refetch discards an in-flight Test (a secret-only rotation is invisible in the redacted response)", async () => {
    const user = userEvent.setup();
    const qc = createTestQueryClient();
    let gets = 0;
    let resolveRefetch: ((value: Response) => void) | null = null;
    let resolveTest: (value: Response) => void = () => undefined;
    const config = makeConfig({ webhook: { url: "https://hook.example", enabled: true, secretConfigured: true } });
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        gets += 1;
        if (gets === 1) return Promise.resolve(jsonResponse({ config }));
        return new Promise<Response>((resolve) => {
          resolveRefetch = resolve;
        });
      }
      if (url === "/api/config/test-webhook") {
        return new Promise<Response>((resolve) => {
          resolveTest = resolve;
        });
      }
      if (url === "/api/sync/status") return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />, { queryClient: qc });
    await screen.findByLabelText(/signing secret/i);

    await user.click(screen.getByRole("button", { name: /^test$/i }));
    void qc.invalidateQueries({ queryKey: ["config"] });
    await waitFor(() => expect(resolveRefetch).not.toBeNull());
    // Identical payload — the only thing that could have changed is the redacted secret.
    resolveRefetch!(jsonResponse({ config }));
    await new Promise((r) => setTimeout(r, 30));
    resolveTest(jsonResponse({ ok: true, statusCode: 200, bodySnippet: "pong", durationMs: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();
  });

  it("Clear sends webhook.secret as an empty string so the server drops the stored secret", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true, secretConfigured: true },
      }),
    });
    renderWithProviders(<Settings />);

    await screen.findByLabelText(/signing secret/i);
    await user.click(screen.getByRole("button", { name: /^clear$/i }));
    expect(screen.getByLabelText(/signing secret/i)).toHaveAttribute(
      "placeholder",
      expect.stringMatching(/cleared/i),
    );
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      const body = findPost("/api/config");
      expect(body.webhook).toEqual({ url: "https://hook.example", enabled: true, secret: "" });
    });
  });

  // Copilot review on PR #19: Test must exercise the DRAFT secret, not the
  // stored one, or it reports success against a receiver that can't verify
  // the value about to be saved.
  it("Test sends the draft secret so the receiver verifies the value about to be saved", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true, secretConfigured: true },
      }),
    });
    renderWithProviders(<Settings />);

    await user.type(await screen.findByLabelText(/signing secret/i), "draft-secret");
    await user.click(screen.getByRole("button", { name: /^test$/i }));

    await waitFor(() => {
      const body = findPost("/api/config/test-webhook");
      expect(body).toEqual({ url: "https://hook.example", secret: "draft-secret" });
    });
  });

  it("Test sends the edited instance id draft, and omits it when the field is blank", async () => {
    // Copilot review on PR #19 round 9: Test must stamp the instance id the
    // user is about to save, not the previously stored one.
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true },
        instanceId: "inst-old",
      }),
    });
    renderWithProviders(<Settings />);
    const instanceInput = await screen.findByLabelText(/instance id/i);
    await user.clear(instanceInput);
    await user.type(instanceInput, "  inst-draft  ");
    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await waitFor(() => {
      expect(findPost("/api/config/test-webhook")).toEqual({
        url: "https://hook.example",
        instanceId: "inst-draft",
      });
    });

    await user.clear(instanceInput);
    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await waitFor(() => {
      const calls = stub.fetch.mock.calls.filter(([i]) => String(i) === "/api/config/test-webhook");
      expect(calls.length).toBe(2);
      expect(JSON.parse(String((calls[1]![1] as RequestInit).body))).toEqual({
        url: "https://hook.example",
      });
    });
  });

  it("Test omits the secret when the field is untouched (server signs with the stored one) and sends '' after Clear", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true, secretConfigured: true },
      }),
    });
    renderWithProviders(<Settings />);
    await screen.findByLabelText(/signing secret/i);

    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await waitFor(() => {
      expect(findPost("/api/config/test-webhook")).toEqual({ url: "https://hook.example" });
    });

    await user.click(screen.getByRole("button", { name: /^clear$/i }));
    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await waitFor(() => {
      const calls = stub.fetch.mock.calls.filter(
        ([i]) => String(i) === "/api/config/test-webhook",
      );
      expect(calls.length).toBe(2);
      const body = JSON.parse(String((calls[1]![1] as RequestInit).body));
      expect(body).toEqual({ url: "https://hook.example", secret: "" });
    });
  });

  it("editing, generating, or clearing the secret discards a prior Test result (it no longer describes the draft)", async () => {
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({
        webhook: { url: "https://hook.example", enabled: true, secretConfigured: true },
      }),
    });
    renderWithProviders(<Settings />);
    await screen.findByLabelText(/signing secret/i);

    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await screen.findByText(/connection success/i);
    await user.click(screen.getByRole("button", { name: /generate/i }));
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await screen.findByText(/connection success/i);
    await user.type(screen.getByLabelText(/signing secret/i), "x");
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await screen.findByText(/connection success/i);
    await user.click(screen.getByRole("button", { name: /^clear$/i }));
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();
  });

  it("ignores a Test response that arrives after the secret draft changed (in-flight result is stale)", async () => {
    // Copilot review on PR #19 round 7: clearing testResult on edit doesn't
    // stop a pending test() from calling setTestResult(r) for the OLD draft.
    const user = userEvent.setup();
    let resolveTest: (value: Response) => void = () => undefined;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        return Promise.resolve(
          jsonResponse({
            config: makeConfig({ webhook: { url: "https://hook.example", enabled: true } }),
          }),
        );
      }
      if (url === "/api/config/test-webhook") {
        return new Promise<Response>((resolve) => {
          resolveTest = resolve;
        });
      }
      if (url === "/api/sync/status") return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />);
    await screen.findByLabelText(/signing secret/i);

    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await user.type(screen.getByLabelText(/signing secret/i), "changed");
    resolveTest(jsonResponse({ ok: true, statusCode: 200, bodySnippet: "pong", durationMs: 1 }));

    // Give the stale promise every chance to land, then assert it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();
  });

  it("a refetch landing mid-edit does not discard an in-progress secret draft (hydrate only when clean)", async () => {
    // Copilot review on PR #19 round 12 (suppressed finding): the hydration
    // effect ran on every cfg.data change, so a background refetch reset
    // the secret draft to "" and the following Save silently kept the old
    // secret.
    const user = userEvent.setup();
    const qc = createTestQueryClient();
    let resolveRefetch: ((value: Response) => void) | null = null;
    let gets = 0;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        gets += 1;
        if (gets === 1) {
          return Promise.resolve(
            jsonResponse({
              config: makeConfig({ webhook: { url: "https://hook.example", enabled: true } }),
            }),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveRefetch = resolve;
        });
      }
      if (url === "/api/config" && method === "POST") {
        return Promise.resolve(jsonResponse({ config: makeConfig() }));
      }
      if (url === "/api/sync/status") return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />, { queryClient: qc });
    await screen.findByLabelText(/signing secret/i);

    // Kick off a background refetch and edit while it is in flight.
    void qc.invalidateQueries({ queryKey: ["config"] });
    await waitFor(() => expect(resolveRefetch).not.toBeNull());
    await user.type(screen.getByLabelText(/signing secret/i), "draft-in-progress");
    resolveRefetch!(
      jsonResponse({
        config: makeConfig({ webhook: { url: "https://hook.example", enabled: true } }),
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.getByLabelText(/signing secret/i)).toHaveValue("draft-in-progress");
    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => {
      const body = findPost("/api/config");
      expect(body.webhook).toEqual({
        url: "https://hook.example",
        enabled: true,
        secret: "draft-in-progress",
      });
    });
  });

  it("disables the editable controls while a save is in flight so a late edit cannot be silently lost", async () => {
    // Copilot review on PR #19 round 13 (suppressed finding): an edit made
    // after clicking Save was neither saved nor kept — the post-save
    // re-hydration discarded it.
    const user = userEvent.setup();
    let resolvePost: (value: Response) => void = () => undefined;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        return Promise.resolve(
          jsonResponse({ config: makeConfig({ webhook: { url: "https://hook.example", enabled: true } }) }),
        );
      }
      if (url === "/api/config" && method === "POST") {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      if (url === "/api/sync/status") return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />);
    await user.type(await screen.findByLabelText(/signing secret/i), "s");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(screen.getByLabelText(/signing secret/i)).toBeDisabled());
    expect(screen.getByLabelText(/instance id/i)).toBeDisabled();
    expect(screen.getByPlaceholderText(/api\.yourdomain\.com/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /generate/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^test$/i })).toBeDisabled();

    resolvePost(jsonResponse({ config: makeConfig({ webhook: { url: "https://hook.example", enabled: true, secretConfigured: true } }) }));
    await waitFor(() => expect(screen.getByLabelText(/signing secret/i)).toBeEnabled());
  });

  it("a refetch that hydrates DIFFERENT server values discards an in-flight Test result (it described the old values)", async () => {
    // Copilot review on PR #19 round 14 (suppressed finding): a clean form
    // is re-hydrated from a background refetch, but a Test started against
    // the previous URL/instance could still resolve and read as success for
    // the new values.
    const user = userEvent.setup();
    const qc = createTestQueryClient();
    let gets = 0;
    let resolveRefetch: ((value: Response) => void) | null = null;
    let resolveTest: (value: Response) => void = () => undefined;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        gets += 1;
        if (gets === 1) {
          return Promise.resolve(
            jsonResponse({ config: makeConfig({ webhook: { url: "https://old.example", enabled: true } }) }),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveRefetch = resolve;
        });
      }
      if (url === "/api/config/test-webhook") {
        return new Promise<Response>((resolve) => {
          resolveTest = resolve;
        });
      }
      if (url === "/api/sync/status") return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />, { queryClient: qc });
    await screen.findByLabelText(/signing secret/i);

    await user.click(screen.getByRole("button", { name: /^test$/i })); // in flight against old.example
    void qc.invalidateQueries({ queryKey: ["config"] });
    await waitFor(() => expect(resolveRefetch).not.toBeNull());
    resolveRefetch!(
      jsonResponse({ config: makeConfig({ webhook: { url: "https://new.example", enabled: true } }) }),
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/api\.yourdomain\.com/i)).toHaveValue("https://new.example"),
    );
    resolveTest(jsonResponse({ ok: true, statusCode: 200, bodySnippet: "pong", durationMs: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();
  });

  it("sends only the fields the user edited — an untouched instance id is never re-posted", async () => {
    // Copilot review on PR #19 round 19: instanceId rode along on every
    // save, so a value changed elsewhere could be overwritten by this
    // page's stale copy on an unrelated (poll/Jira) save.
    const user = userEvent.setup();
    routeSettingsFetch(stub, {
      config: makeConfig({ webhook: null, instanceId: "inst-server", pollIntervalMinutes: 10 }),
    });
    renderWithProviders(<Settings />);
    await screen.findByLabelText(/instance id/i);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "15" } });
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      const body = findPost("/api/config");
      expect(body).toEqual({ pollIntervalMinutes: 15 });
    });
  });

  it("a refetch re-hydrates UNTOUCHED fields while an edited field keeps its draft (no stale URL saved with a new secret)", async () => {
    // Copilot review on PR #19 round 19: with a page-wide dirty gate, editing
    // only the secret left the URL stale after a refetch, and Save combined
    // the stale URL with the new secret.
    const user = userEvent.setup();
    const qc = createTestQueryClient();
    let gets = 0;
    let resolveRefetch: ((value: Response) => void) | null = null;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        gets += 1;
        if (gets === 1) {
          return Promise.resolve(
            jsonResponse({ config: makeConfig({ webhook: { url: "https://old.example", enabled: true }, instanceId: "inst-old" }) }),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveRefetch = resolve;
        });
      }
      if (url === "/api/config" && method === "POST") return Promise.resolve(jsonResponse({ config: makeConfig() }));
      if (url === "/api/sync/status") return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<Settings />, { queryClient: qc });
    await user.type(await screen.findByLabelText(/signing secret/i), "new-secret");

    void qc.invalidateQueries({ queryKey: ["config"] });
    await waitFor(() => expect(resolveRefetch).not.toBeNull());
    resolveRefetch!(
      jsonResponse({ config: makeConfig({ webhook: { url: "https://new.example", enabled: true }, instanceId: "inst-new" }) }),
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText(/api\.yourdomain\.com/i)).toHaveValue("https://new.example"),
    );
    expect(screen.getByLabelText(/instance id/i)).toHaveValue("inst-new");
    expect(screen.getByLabelText(/signing secret/i)).toHaveValue("new-secret");

    await user.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() => {
      const body = findPost("/api/config");
      expect(body).toEqual({
        webhook: { url: "https://new.example", enabled: true, secret: "new-secret" },
      });
    });
  });

  it("shows a placeholder when the server has not minted an instance id yet", async () => {
    routeSettingsFetch(stub, { config: makeConfig({ instanceId: null }) });
    renderWithProviders(<Settings />);
    expect(await screen.findByLabelText(/instance id/i)).toHaveValue("");
    expect(screen.getByLabelText(/instance id/i)).toHaveAttribute(
      "placeholder",
      expect.stringMatching(/generated/i),
    );
  });
});

describe("Settings — Save/Test gated on a settled, refetch-free config query", () => {
  // Copilot review on PR #19 (suppressed finding): React Query keeps the last
  // good config while a refetch is in flight or after one fails, so the page
  // still renders and Save/Test stayed enabled against possibly-stale values —
  // a secret-only Save would re-post the cached webhook URL, and Test would
  // send the cached instance id. WebhookStep already gates both controls on
  // `cfg.isSuccess && !cfg.isFetching`; Settings mirrors it.
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  // First GET resolves with a stored webhook + instance id; the second GET is
  // handed back to the test so it can be held in flight or failed on demand.
  function routeWithHeldRefetch(): { resolveRefetch: () => (value: Response) => void } {
    let gets = 0;
    let resolveRefetch: ((value: Response) => void) | null = null;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        gets += 1;
        if (gets === 1) {
          return Promise.resolve(
            jsonResponse({ config: makeConfig({ webhook: { url: "https://stored.example", enabled: true }, instanceId: "inst-stored" }) }),
          );
        }
        return new Promise<Response>((resolve) => {
          resolveRefetch = resolve;
        });
      }
      if (url === "/api/sync/status") return Promise.resolve(jsonResponse(syncStatus()));
      return Promise.resolve(jsonResponse({}));
    });
    return {
      resolveRefetch: () => {
        expect(resolveRefetch).not.toBeNull();
        return resolveRefetch!;
      },
    };
  }

  it("disables Save and Test while a config refetch is in flight, and re-enables them once it lands", async () => {
    const user = userEvent.setup();
    const qc = createTestQueryClient();
    const held = routeWithHeldRefetch();
    renderWithProviders(<Settings />, { queryClient: qc });
    await user.type(await screen.findByLabelText(/signing secret/i), "new-secret");
    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    const testBtn = screen.getByRole("button", { name: /^test$/i });
    expect(saveBtn).not.toBeDisabled();
    expect(testBtn).not.toBeDisabled();

    void qc.invalidateQueries({ queryKey: ["config"] });
    await waitFor(() => expect(saveBtn).toBeDisabled());
    expect(testBtn).toBeDisabled();

    held.resolveRefetch()(
      jsonResponse({ config: makeConfig({ webhook: { url: "https://stored.example", enabled: true }, instanceId: "inst-stored" }) }),
    );
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    expect(testBtn).not.toBeDisabled();
    // The draft survived the refetch — the gate only holds the click, it
    // does not discard the edit.
    expect(screen.getByLabelText(/signing secret/i)).toHaveValue("new-secret");
  });

  it("keeps Save and Test disabled when a refetch fails and the cached config is still shown", async () => {
    const user = userEvent.setup();
    const qc = createTestQueryClient();
    const held = routeWithHeldRefetch();
    renderWithProviders(<Settings />, { queryClient: qc });
    await user.type(await screen.findByLabelText(/signing secret/i), "new-secret");
    const saveBtn = screen.getByRole("button", { name: /save settings/i });
    const testBtn = screen.getByRole("button", { name: /^test$/i });

    void qc.invalidateQueries({ queryKey: ["config"] });
    await waitFor(() => expect(saveBtn).toBeDisabled());
    held.resolveRefetch()(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    // The query settles into its error state but keeps the cached data, so
    // the form still renders the stored values rather than "failed to load"…
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/api\.yourdomain\.com/i)).toHaveValue("https://stored.example");
    expect(screen.getByLabelText(/instance id/i)).toHaveValue("inst-stored");
    // …and that is exactly why both controls must stay disabled: the values
    // they would send may no longer match the server.
    expect(saveBtn).toBeDisabled();
    expect(testBtn).toBeDisabled();
    expect(stub.fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });
});
