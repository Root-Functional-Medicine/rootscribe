import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AppConfig,
  SyncStatusResponse,
  WebhookTestResponse,
} from "@rootscribe/shared";
import { DEFAULT_CONFIG } from "@rootscribe/shared";
import { Settings } from "./Settings.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../test-utils.js";

// Settings composes two queries (config + sync-status, the latter on a 5s
// interval) and three actions (webhook test, config save, implicit refetch
// via cache invalidation). Every test hits the real jsonFetch → fetch
// pipeline through a stubbed global.fetch.

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    token: "tok",
    tokenExp: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    tokenEmail: "alice@example.com",
    recordingsDir: "/tmp/rec",
    pollIntervalMinutes: 10,
    setupComplete: true,
    ...overrides,
  };
}

function syncStatus(
  overrides: Partial<SyncStatusResponse> = {},
): SyncStatusResponse {
  return {
    lastPollAt: Date.now() - 30_000,
    nextPollAt: Date.now() + 30_000,
    polling: false,
    pendingTranscripts: 0,
    errorsLast24h: 0,
    lastError: null,
    authRequired: false,
    ...overrides,
  };
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
    routeSettingsFetch(stub, { config: makeConfig({ webhook: null }) });
    renderWithProviders(<Settings />);
    const webhookInput = await screen.findByPlaceholderText(
      /api\.yourdomain\.com/i,
    );
    // Deliberate surrounding whitespace — Settings trims on save to keep the
    // server from seeing "  https://hook  " values.
    await user.type(webhookInput, "  https://hook.example  ");
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => {
      const postCall = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeDefined();
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
      expect(body.pollIntervalMinutes).toBe(10);
      // Blank Jira URL → default (preserves the "clear" gesture without
      // leaving the stored value dangling).
      expect(body.jiraBaseUrl).toBe(DEFAULT_CONFIG.jiraBaseUrl);
    });
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
