import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppConfig } from "@rootscribe/shared";
import { DEFAULT_CONFIG } from "@rootscribe/shared";
import { ReviewStep } from "./ReviewStep.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../../test-utils.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    tokenEmail: "alice@example.com",
    recordingsDir: "/srv/recordings",
    pollIntervalMinutes: 10,
    bind: { host: "127.0.0.1", port: 44471 },
    setupComplete: false,
    ...overrides,
  };
}

function routeReviewFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    config?: AppConfig;
    configPending?: boolean;
    configError?: boolean;
  } = {},
): void {
  stub.fetch.mockImplementation(() => {
    if (opts.configPending) return new Promise(() => undefined);
    if (opts.configError) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "nope" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      jsonResponse({ config: opts.config ?? makeConfig() }),
    );
  });
}

describe("ReviewStep — load states", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("shows a loading placeholder while config is pending", () => {
    routeReviewFetch(stub, { configPending: true });
    renderWithProviders(
      <ReviewStep onFinish={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByText(/^loading…$/i)).toBeInTheDocument();
  });

  it("renders the 'failed to load' fallback when the query errors", async () => {
    routeReviewFetch(stub, { configError: true });
    renderWithProviders(
      <ReviewStep onFinish={vi.fn()} onBack={vi.fn()} />,
    );
    expect(
      await screen.findByText(/failed to load/i),
    ).toBeInTheDocument();
  });
});

describe("ReviewStep — config summary rows", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders every row: account email, recordings dir, webhook, jira URL, poll interval, bind host:port", async () => {
    routeReviewFetch(stub, {
      config: makeConfig({
        tokenEmail: "alice@example.com",
        recordingsDir: "/srv/recordings",
        webhook: { url: "https://hook.example/ingest", enabled: true },
        jiraBaseUrl: "https://myco.atlassian.net/browse/",
        pollIntervalMinutes: 15,
        bind: { host: "0.0.0.0", port: 44500 },
      }),
    });
    renderWithProviders(
      <ReviewStep onFinish={vi.fn()} onBack={vi.fn()} />,
    );
    expect(
      await screen.findByText("alice@example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("/srv/recordings")).toBeInTheDocument();
    expect(screen.getByText("https://hook.example/ingest")).toBeInTheDocument();
    expect(
      screen.getByText("https://myco.atlassian.net/browse/"),
    ).toBeInTheDocument();
    expect(screen.getByText(/every 15 min/i)).toBeInTheDocument();
    expect(screen.getByText("0.0.0.0:44500")).toBeInTheDocument();
  });

  it("shows 'unknown' when tokenEmail is null and 'none' when webhook is null", async () => {
    routeReviewFetch(stub, {
      config: makeConfig({ tokenEmail: null, webhook: null }),
    });
    renderWithProviders(
      <ReviewStep onFinish={vi.fn()} onBack={vi.fn()} />,
    );
    expect(await screen.findByText(/^unknown$/i)).toBeInTheDocument();
    expect(screen.getByText(/^none$/i)).toBeInTheDocument();
  });

  it("shows '(not set)' when recordingsDir is null", async () => {
    routeReviewFetch(stub, {
      config: makeConfig({ recordingsDir: null }),
    });
    renderWithProviders(
      <ReviewStep onFinish={vi.fn()} onBack={vi.fn()} />,
    );
    expect(await screen.findByText(/\(not set\)/)).toBeInTheDocument();
  });
});

describe("ReviewStep — navigation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("'Save & start syncing' calls onFinish exactly once", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn().mockResolvedValue(undefined);
    routeReviewFetch(stub, { config: makeConfig() });
    renderWithProviders(
      <ReviewStep onFinish={onFinish} onBack={vi.fn()} />,
    );
    await user.click(
      await screen.findByRole("button", { name: /save & start syncing/i }),
    );
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("Back button calls onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    routeReviewFetch(stub, { config: makeConfig() });
    renderWithProviders(
      <ReviewStep onFinish={vi.fn()} onBack={onBack} />,
    );
    await user.click(
      await screen.findByRole("button", { name: /^back$/i }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
