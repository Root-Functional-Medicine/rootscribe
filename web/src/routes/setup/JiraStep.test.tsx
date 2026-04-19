import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppConfig } from "@rootscribe/shared";
import { DEFAULT_CONFIG } from "@rootscribe/shared";
import { JiraStep } from "./JiraStep.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../../test-utils.js";

// JiraStep composes:
// - GET /api/config (seed the input from cfg.data.config.jiraBaseUrl)
// - POST /api/config (save jiraBaseUrl, invalidate ["config"])

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    tokenEmail: "alice@example.com",
    setupComplete: false,
    ...overrides,
  };
}

function routeJiraFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    config?: AppConfig;
    configPending?: boolean;
    configError?: boolean;
    save?: "ok" | "throw";
  } = {},
): void {
  stub.fetch.mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/config" && method === "GET") {
      if (opts.configPending) return new Promise(() => undefined);
      if (opts.configError) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "load failed" }), {
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
      if (opts.save === "throw") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "bad URL" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ config: opts.config ?? makeConfig() }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("JiraStep — seed from config", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("disables Next with 'Loading…' while the config query is in flight", () => {
    routeJiraFetch(stub, { configPending: true });
    renderWithProviders(<JiraStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /loading…/i }),
    ).toBeDisabled();
  });

  it("seeds the URL input from the loaded config", async () => {
    routeJiraFetch(stub, {
      config: makeConfig({
        jiraBaseUrl: "https://acme.atlassian.net/browse/",
      }),
    });
    renderWithProviders(<JiraStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(
      await screen.findByDisplayValue(
        "https://acme.atlassian.net/browse/",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to DEFAULT_CONFIG.jiraBaseUrl when the config query errors (still unblocks Next)", async () => {
    routeJiraFetch(stub, { configError: true });
    renderWithProviders(<JiraStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(
      await screen.findByDisplayValue(DEFAULT_CONFIG.jiraBaseUrl),
    ).toBeInTheDocument();
    // Next is enabled again (labeled "Next", not "Loading…").
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^next$/i }),
      ).not.toBeDisabled(),
    );
  });
});

describe("JiraStep — live preview", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("renders a DEVX-96 preview that normalizes trailing slashes on the input", async () => {
    const user = userEvent.setup();
    routeJiraFetch(stub, { config: makeConfig({ jiraBaseUrl: "" }) });
    renderWithProviders(<JiraStep onNext={vi.fn()} onBack={vi.fn()} />);
    const input = await screen.findByPlaceholderText(
      DEFAULT_CONFIG.jiraBaseUrl,
    );
    await user.clear(input);
    await user.type(input, "https://myco.atlassian.net/browse///");
    expect(
      screen.getByText(/myco\.atlassian\.net\/browse\/DEVX-96/),
    ).toBeInTheDocument();
  });

  it("shows 'Use RFM default' only when the URL differs from DEFAULT_CONFIG.jiraBaseUrl; click restores the default", async () => {
    const user = userEvent.setup();
    routeJiraFetch(stub, {
      config: makeConfig({ jiraBaseUrl: "https://other.example/browse/" }),
    });
    renderWithProviders(<JiraStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByDisplayValue("https://other.example/browse/");
    const useDefault = screen.getByRole("button", {
      name: /use rfm default/i,
    });
    await user.click(useDefault);
    expect(
      screen.getByDisplayValue(DEFAULT_CONFIG.jiraBaseUrl),
    ).toBeInTheDocument();
    // Button hides once the URL matches the default.
    expect(
      screen.queryByRole("button", { name: /use rfm default/i }),
    ).not.toBeInTheDocument();
  });
});

describe("JiraStep — save + navigation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("Next POSTs the trimmed URL and calls onNext on success", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeJiraFetch(stub, { config: makeConfig({ jiraBaseUrl: "" }) });
    renderWithProviders(<JiraStep onNext={onNext} onBack={vi.fn()} />);
    const input = await screen.findByPlaceholderText(
      DEFAULT_CONFIG.jiraBaseUrl,
    );
    await user.clear(input);
    await user.type(input, "  https://myco.atlassian.net/browse/  ");
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        jiraBaseUrl: string;
      };
      // Leading/trailing whitespace is trimmed on save.
      expect(body.jiraBaseUrl).toBe("https://myco.atlassian.net/browse/");
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("blank URL falls back to DEFAULT_CONFIG.jiraBaseUrl on save", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeJiraFetch(stub, { config: makeConfig({ jiraBaseUrl: "" }) });
    renderWithProviders(<JiraStep onNext={onNext} onBack={vi.fn()} />);
    const input = await screen.findByPlaceholderText(
      DEFAULT_CONFIG.jiraBaseUrl,
    );
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        jiraBaseUrl: string;
      };
      expect(body.jiraBaseUrl).toBe(DEFAULT_CONFIG.jiraBaseUrl);
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("surfaces the server error inline and does not navigate when save fails", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeJiraFetch(stub, {
      config: makeConfig({ jiraBaseUrl: "" }),
      save: "throw",
    });
    renderWithProviders(<JiraStep onNext={onNext} onBack={vi.fn()} />);
    // Wait for initialization (button label flips from "Loading…" to "Next")
    // before clicking — clicking while disabled is a no-op that would mask
    // the real server-error flow.
    const nextBtn = await screen.findByRole("button", { name: /^next$/i });
    await user.click(nextBtn);

    expect(await screen.findByText(/bad URL/i)).toBeInTheDocument();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("Back button calls onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    routeJiraFetch(stub, { config: makeConfig() });
    renderWithProviders(<JiraStep onNext={vi.fn()} onBack={onBack} />);
    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
