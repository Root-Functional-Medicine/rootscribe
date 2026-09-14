import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AppConfig, WebhookTestResponse } from "@rootscribe/shared";
import { WebhookStep } from "./WebhookStep.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../../test-utils.js";
import { appConfigFactory } from "../../test-factories/index.js";

// WebhookStep composes:
// - GET /api/config (reads the server-minted instance id for display)
// - POST /api/config/test-webhook (dry-run, optional)
// - POST /api/config (save; sends webhook=null on empty, { url, enabled: true[, secret] } otherwise)
// Every test drives the real jsonFetch pipeline via a stubbed global.fetch.

function routeWebhookFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: {
    config?: AppConfig;
    test?: WebhookTestResponse | "pending";
    save?: "ok" | "throw";
  } = {},
): void {
  stub.fetch.mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    if (url === "/api/config" && method === "GET") {
      return Promise.resolve(
        jsonResponse({ config: opts.config ?? appConfigFactory.authenticated().build() }),
      );
    }
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^skip$/i })).toBeEnabled(),
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled(),
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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^skip$/i })).toBeEnabled(),
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

describe("WebhookStep — signing secret + instance id", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => stub.cleanup());

  it("displays the server-minted instance id so the user can copy it into their receiver", async () => {
    routeWebhookFetch(stub, {
      config: appConfigFactory.authenticated().withInstanceId("inst-wizard-42").build(),
    });
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(await screen.findByText("inst-wizard-42")).toBeInTheDocument();
  });

  it("tells a resumed wizard that a stored secret is kept when the field is left blank", async () => {
    // Copilot review on PR #19 round 4: setup can be abandoned after this
    // step saved a secret, and Next/Test both preserve a stored secret when
    // the field is blank — so "leave blank to send unsigned" would be false.
    routeWebhookFetch(stub, {
      config: appConfigFactory
        .authenticated()
        .withWebhook({ url: "https://hook.example", enabled: true, secretConfigured: true })
        .build(),
    });
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/signing secret/i)).toHaveAttribute(
        "placeholder",
        expect.stringMatching(/keep/i),
      );
    });
  });

  it("hydrates the URL from a stored webhook so revisiting the step offers Next, not a destructive Skip", async () => {
    // Copilot review on PR #19 round 5: with url starting at "", a revisit
    // rendered "Skip", whose click sends webhook=null and deletes the stored
    // URL and secret — contradicting the "stored secret is kept" copy.
    routeWebhookFetch(stub, {
      config: appConfigFactory
        .authenticated()
        .withWebhook({ url: "https://stored.example/ingest", enabled: true, secretConfigured: true })
        .build(),
    });
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/api\.yourdomain\.com/i)).toHaveValue(
        "https://stored.example/ingest",
      );
    });
    expect(screen.getByRole("button", { name: /^next$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^skip$/i })).not.toBeInTheDocument();
  });

  it("does not clobber a URL the user has already typed when the config arrives", async () => {
    const user = userEvent.setup();
    let resolveConfig: (value: Response) => void = () => undefined;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        return new Promise<Response>((resolve) => {
          resolveConfig = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);

    await user.type(screen.getByPlaceholderText(/api\.yourdomain\.com/i), "https://typed.example");
    resolveConfig(
      jsonResponse({
        config: appConfigFactory
          .authenticated()
          .withWebhook({ url: "https://stored.example/ingest", enabled: true })
          .build(),
      }),
    );
    await screen.findByText(/instance id/i);
    expect(screen.getByPlaceholderText(/api\.yourdomain\.com/i)).toHaveValue("https://typed.example");
  });

  it("disables the primary button until the config query has settled, so Skip cannot fire on unknown stored state", async () => {
    // Copilot review on PR #19 round 6: clicking Skip before /api/config
    // resolved left url="" and posted webhook=null — deleting a stored URL
    // and secret on a resumed wizard.
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") return new Promise(() => undefined);
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^skip$/i })).toBeDisabled();
  });

  it("when the config query failed and the URL is untouched, Skip proceeds WITHOUT posting webhook=null", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "boom" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ config: {} }));
    });
    renderWithProviders(<WebhookStep onNext={onNext} onBack={vi.fn()} />);

    const skip = screen.getByRole("button", { name: /^skip$/i });
    await waitFor(() => expect(skip).toBeEnabled());
    await user.click(skip);

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    const posted = stub.fetch.mock.calls.some(
      ([i, init]) =>
        String(i) === "/api/config" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBe(false);
  });

  it("ignores a Test Connection response that arrives after the secret draft changed", async () => {
    const user = userEvent.setup();
    let resolveTest: (value: Response) => void = () => undefined;
    stub.fetch.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : String(input);
      const method = ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
      if (url === "/api/config" && method === "GET") {
        return Promise.resolve(jsonResponse({ config: appConfigFactory.authenticated().build() }));
      }
      if (url.includes("/api/config/test-webhook")) {
        return new Promise<Response>((resolve) => {
          resolveTest = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}));
    });
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/api\.yourdomain\.com/i), "https://hook.example");

    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await user.type(screen.getByLabelText(/signing secret/i), "changed");
    resolveTest(jsonResponse({ ok: true, statusCode: 200, bodySnippet: "pong", durationMs: 1 }));

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();
  });

  it("invalidates the shared config query after saving so a Back navigation cannot Skip-delete the just-saved webhook", async () => {
    // Copilot review on PR #19 round 7: the app keeps ['config'] fresh for
    // 5s, so without invalidation a remount after Next -> Back would hydrate
    // from the stale cache (webhook: null), show Skip, and post null.
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeWebhookFetch(stub);
    renderWithProviders(<WebhookStep onNext={onNext} onBack={vi.fn()} />);
    await screen.findByText(/instance id/i);
    const getsBefore = stub.fetch.mock.calls.filter(
      ([i, init]) =>
        String(i) === "/api/config" &&
        ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET",
    ).length;

    await user.type(screen.getByPlaceholderText(/api\.yourdomain\.com/i), "https://hook.example");
    await waitFor(() => expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /^next$/i }));

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const getsAfter = stub.fetch.mock.calls.filter(
        ([i, init]) =>
          String(i) === "/api/config" &&
          ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET",
      ).length;
      expect(getsAfter).toBeGreaterThan(getsBefore);
    });
  });

  it("tells a fresh wizard that a blank field sends unsigned", async () => {
    routeWebhookFetch(stub);
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(/instance id/i);
    expect(screen.getByLabelText(/signing secret/i)).toHaveAttribute(
      "placeholder",
      expect.stringMatching(/unsigned/i),
    );
  });

  it("Generate fills the signing secret with 64 hex characters", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub);
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /generate/i }));

    expect(
      (screen.getByLabelText(/signing secret/i) as HTMLInputElement).value,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("clicking Next with a URL and a secret POSTs webhook { url, enabled: true, secret }", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeWebhookFetch(stub);
    renderWithProviders(<WebhookStep onNext={onNext} onBack={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    await user.type(screen.getByLabelText(/signing secret/i), "  whsec_wizard  ");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^next$/i })).toBeEnabled(),
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
        webhook: unknown;
      };
      expect(body.webhook).toEqual({
        url: "https://hook.example",
        enabled: true,
        secret: "whsec_wizard",
      });
    });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });

  // Copilot review on PR #19: Test Connection must sign with the DRAFT
  // secret, or a newly generated value "succeeds" against a receiver that
  // could never verify it.
  it("Test Connection sends the draft secret alongside the URL", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub);
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    await user.type(screen.getByLabelText(/signing secret/i), "  draft-secret  ");
    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(([i]) =>
        String(i).includes("/api/config/test-webhook"),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        url: "https://hook.example",
        secret: "draft-secret",
      });
    });
  });

  it("editing or generating the secret discards a prior Test Connection result", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub);
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);
    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );

    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await screen.findByText(/connection success/i);
    await user.type(screen.getByLabelText(/signing secret/i), "s");
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /test connection/i }));
    await screen.findByText(/connection success/i);
    await user.click(screen.getByRole("button", { name: /generate/i }));
    expect(screen.queryByText(/connection success/i)).not.toBeInTheDocument();
  });

  it("Test Connection omits the secret when the field is blank", async () => {
    const user = userEvent.setup();
    routeWebhookFetch(stub);
    renderWithProviders(<WebhookStep onNext={vi.fn()} onBack={vi.fn()} />);

    await user.type(
      screen.getByPlaceholderText(/api\.yourdomain\.com/i),
      "https://hook.example",
    );
    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(([i]) =>
        String(i).includes("/api/config/test-webhook"),
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
        url: "https://hook.example",
      });
    });
  });
});
