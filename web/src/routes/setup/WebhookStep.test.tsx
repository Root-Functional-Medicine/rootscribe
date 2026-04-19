import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WebhookTestResponse } from "@rootscribe/shared";
import { WebhookStep } from "./WebhookStep.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../../test-utils.js";

// WebhookStep composes:
// - POST /api/config/test-webhook (dry-run, optional)
// - POST /api/config (save; sends webhook=null on empty, { url, enabled: true } otherwise)
// Every test drives the real jsonFetch pipeline via a stubbed global.fetch.

function routeWebhookFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    test?: WebhookTestResponse | "pending";
    save?: "ok" | "throw";
  } = {},
): void {
  stub.fetch.mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/config/test-webhook")) {
      if (opts.test === "pending") return new Promise(() => undefined);
      return Promise.resolve(
        jsonResponse(
          opts.test ?? {
            ok: true,
            statusCode: 200,
            bodySnippet: "pong",
            durationMs: 10,
          },
        ),
      );
    }
    if (url === "/api/config") {
      if (opts.save === "throw") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ config: {} }));
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("WebhookStep — test connection", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("does not render the Test Connection button when the URL input is empty", () => {
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: /test connection/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the Test Connection button once the user types a URL", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    expect(
      screen.getByRole("button", { name: /test connection/i }),
    ).toBeInTheDocument();
  });

  it("renders 'Connection Success' with HTTP status + body snippet when test passes", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub, {
      test: {
        ok: true,
        statusCode: 202,
        bodySnippet: "accepted",
        durationMs: 42,
      },
    });
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    await user.click(
      screen.getByRole("button", { name: /test connection/i }),
    );
    expect(
      await screen.findByText(/connection success/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/HTTP 202 OK — accepted/i)).toBeInTheDocument();
  });

  it("Test Connection POSTs the TRIMMED URL (not the raw value with whitespace)", async () => {
    // Regression: test() previously sent the raw `url` while the button
    // visibility and save path both used `url.trim()`. The mismatch meant
    // a URL with surrounding whitespace would fail the server-side Zod
    // `z.string().url()` validation with a confusing "invalid URL" even
    // though the input looked fine and the button was clickable.
    const user = userEvent.setup();
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "  https://hook.example  ",
    );
    await user.click(
      screen.getByRole("button", { name: /test connection/i }),
    );

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(([i]) =>
        String(i).includes("/api/config/test-webhook"),
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        url: string;
      };
      expect(body.url).toBe("https://hook.example");
    });
  });

  it("renders 'Connection Failed' with the HTTP status when the test returns ok=false with a status code", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub, {
      test: { ok: false, statusCode: 500, durationMs: 10 },
    });
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    await user.click(
      screen.getByRole("button", { name: /test connection/i }),
    );
    expect(
      await screen.findByText(/connection failed/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it("renders the error message when the test returns ok=false with no status code", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub, {
      test: {
        ok: false,
        error: "DNS resolution failed",
        durationMs: 10,
      },
    });
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    await user.click(
      screen.getByRole("button", { name: /test connection/i }),
    );
    expect(
      await screen.findByText(/DNS resolution failed/i),
    ).toBeInTheDocument();
  });

  it("editing the URL after a test result clears the result", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    await user.click(
      screen.getByRole("button", { name: /test connection/i }),
    );
    await screen.findByText(/connection success/i);

    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "x",
    );
    expect(
      screen.queryByText(/connection success/i),
    ).not.toBeInTheDocument();
  });
});

describe("WebhookStep — save + navigation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("the primary button label flips to 'Skip' when the URL is empty", () => {
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /^skip$/i })).toBeInTheDocument();
  });

  it("clicking Skip (empty URL) POSTs webhook=null and calls onNext", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={onNext} onBack={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /^skip$/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        webhook: unknown;
      };
      expect(body.webhook).toBeNull();
    });
    // saveAndContinue() is async and invoked via `void saveAndContinue()` —
    // the POST fires before onNext, so asserting onNext right after the
    // POST waitFor races with api.updateConfig resolving. Wait explicitly.
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });

  it("clicking Next (non-empty URL) POSTs the trimmed URL with enabled=true and calls onNext", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={onNext} onBack={vi.fn()} />,
    );
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "  https://hook.example  ",
    );
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        webhook: { url: string; enabled: boolean };
      };
      expect(body.webhook).toEqual({
        url: "https://hook.example",
        enabled: true,
      });
    });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });

  it("whitespace-only URL input renders the 'Skip' button and POSTs webhook=null on click", async () => {
    // Covers the regression Copilot flagged: prior to the production fix,
    // WebhookStep rendered "Next" for whitespace-only input but still POSTed
    // webhook=null on click. Label + click behavior must stay aligned.
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={onNext} onBack={vi.fn()} />,
    );

    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "   ",
    );
    // Label reflects the trimmed value, not the raw one.
    expect(screen.getByRole("button", { name: /^skip$/i })).toBeInTheDocument();
    // And the Test Connection button stays hidden.
    expect(
      screen.queryByRole("button", { name: /test connection/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^skip$/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i) === "/api/config" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        webhook: unknown;
      };
      expect(body.webhook).toBeNull();
    });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });

  it("clicking Back calls onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    routeWebhookFetch(stub);
    renderWithProviders(
      <WebhookStep onNext={vi.fn()} onBack={onBack} />,
    );
    await user.click(screen.getByRole("button", { name: /^back$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
