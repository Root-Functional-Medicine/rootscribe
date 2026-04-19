import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthStep } from "./AuthStep.js";
import { jsonResponse, renderWithProviders, stubFetch } from "../../test-utils.js";

// AuthStep has three flows:
// - Auto-detect from Chrome (fires on mount) → accept
// - Manual token paste (textarea inside a <details>) → accept
// - Background watch via EventSource (/api/auth/watch/{id}/events)
//
// We stub fetch for authDetect + authAccept + authStartWatch, and stub the
// global EventSource class so tests can trigger onmessage / onerror. The
// watch flow spins a setInterval for elapsed seconds — keep real timers so
// test setup stays simple; the interval is torn down by the component when
// any terminal event fires.

// ---------- EventSource stub ----------
// Must be a real constructor (new EventSource(...) requires one), not a
// vi.fn returning an object — SyncStatusBadge's test file established this
// pattern (see class-based shape below).
interface StubEventSource {
  url: string;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  close: () => void;
}

let lastEventSource: StubEventSource | null = null;

function installEventSourceStub(): void {
  class FakeEventSource implements StubEventSource {
    public onmessage: ((e: MessageEvent) => void) | null = null;
    public onerror: ((e: Event) => void) | null = null;
    public readonly close = vi.fn();
    public readonly _capture = ((): void => {
      lastEventSource = this as StubEventSource;
    })();
    constructor(public readonly url: string) {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);
}

// ---------- fetch router ----------
interface AuthRouterOpts {
  detect?:
    | { found: boolean; email?: string; browser?: string; profile?: string; token?: string; error?: string }
    | "pending"
    | "throw";
  accept?: "ok" | { ok: false; error?: string } | "throw";
  watch?: { watchId: string } | "throw";
}

function routeAuthFetch(
  stub: ReturnType<typeof stubFetch>,
  opts: AuthRouterOpts = {},
): void {
  stub.fetch.mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/api/auth/detect")) {
      if (opts.detect === "pending") return new Promise(() => undefined);
      if (opts.detect === "throw") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "detect failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(opts.detect ?? { found: false }),
      );
    }
    if (url.includes("/api/auth/accept")) {
      if (opts.accept === "throw") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "accept failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (typeof opts.accept === "object") {
        return Promise.resolve(jsonResponse(opts.accept));
      }
      return Promise.resolve(
        jsonResponse({ ok: true, email: "alice@example.com" }),
      );
    }
    if (url.includes("/api/auth/watch")) {
      if (opts.watch === "throw") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "watch failed" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(opts.watch ?? { watchId: "w-123" }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("AuthStep — detect on mount", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    lastEventSource = null;
    installEventSourceStub();
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("shows 'Scanning browsers…' while the initial detect is pending", () => {
    routeAuthFetch(stub, { detect: "pending" });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(
      screen.getByText(/scanning browsers on this machine/i),
    ).toBeInTheDocument();
  });

  it("renders the 'found' state with browser/profile/email when detect returns a token", async () => {
    routeAuthFetch(stub, {
      detect: {
        found: true,
        browser: "Chrome",
        profile: "Default",
        email: "alice@example.com",
        token: "bearer abc",
      },
    });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(
      await screen.findByText(/chrome \/ default/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/alice@example\.com/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use this session/i }),
    ).toBeInTheDocument();
  });

  it("renders the 'notfound' state (+ watch button) when detect returns found=false", async () => {
    routeAuthFetch(stub, { detect: { found: false } });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(
      await screen.findByText(/no existing plaud session found/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /open web\.plaud\.ai and watch for login/i,
      }),
    ).toBeInTheDocument();
  });

  it("renders the 'error' state with a 'Try another method' fallback when detect throws", async () => {
    routeAuthFetch(stub, { detect: "throw" });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    expect(
      await screen.findByText(/detect failed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try another method/i }),
    ).toBeInTheDocument();
  });

  it("'Try another method' switches from error to the notfound/manual UI", async () => {
    const user = userEvent.setup();
    routeAuthFetch(stub, { detect: "throw" });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: /try another method/i }),
    );
    expect(
      await screen.findByText(/no existing plaud session found/i),
    ).toBeInTheDocument();
  });
});

describe("AuthStep — accept detected session", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    installEventSourceStub();
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("'Use this session' POSTs token + email to /api/auth/accept and calls onNext on ok=true", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeAuthFetch(stub, {
      detect: {
        found: true,
        browser: "Chrome",
        profile: "Default",
        email: "alice@example.com",
        token: "bearer-abc",
      },
    });
    renderWithProviders(<AuthStep onNext={onNext} onBack={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: /use this session/i }),
    );

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i).includes("/api/auth/accept") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        token: string;
        email: string;
      };
      expect(body.token).toBe("bearer-abc");
      expect(body.email).toBe("alice@example.com");
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("flips to the error state when accept returns ok=false", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeAuthFetch(stub, {
      detect: {
        found: true,
        browser: "Chrome",
        profile: "Default",
        token: "bearer-abc",
      },
      accept: { ok: false, error: "token expired" },
    });
    renderWithProviders(<AuthStep onNext={onNext} onBack={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: /use this session/i }),
    );
    expect(await screen.findByText(/token expired/i)).toBeInTheDocument();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("'Use a different account' switches to the notfound UI without calling accept", async () => {
    const user = userEvent.setup();
    routeAuthFetch(stub, {
      detect: {
        found: true,
        browser: "Chrome",
        profile: "Default",
        token: "bearer-abc",
      },
    });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: /use a different account/i }),
    );
    expect(
      screen.getByText(/no existing plaud session found/i),
    ).toBeInTheDocument();
    expect(
      stub.fetch.mock.calls.some(([i]) =>
        String(i).includes("/api/auth/accept"),
      ),
    ).toBe(false);
  });
});

describe("AuthStep — manual token paste", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    installEventSourceStub();
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("'Use this token' is disabled until the pasted token is at least 20 chars", async () => {
    const user = userEvent.setup();
    routeAuthFetch(stub, { detect: { found: false } });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);

    const textarea = screen.getByPlaceholderText(/bearer eyJ/i);
    // Short string → disabled.
    await user.type(textarea, "short");
    expect(
      screen.getByRole("button", { name: /use this token/i }),
    ).toBeDisabled();

    // 20+ chars → enabled.
    await user.type(textarea, "xxxxxxxxxxxxxxxxxxxx");
    expect(
      screen.getByRole("button", { name: /use this token/i }),
    ).not.toBeDisabled();
  });

  it("'Use this token' POSTs the pasted token to /api/auth/accept and calls onNext on success", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeAuthFetch(stub, { detect: { found: false }, accept: "ok" });
    renderWithProviders(<AuthStep onNext={onNext} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);

    const textarea = screen.getByPlaceholderText(/bearer eyJ/i);
    const longToken = "bearer eyJ0000000000000000000000";
    await user.type(textarea, longToken);
    await user.click(screen.getByRole("button", { name: /use this token/i }));

    await waitFor(() => {
      const post = stub.fetch.mock.calls.find(
        ([i, init]) =>
          String(i).includes("/api/auth/accept") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse(String((post?.[1] as RequestInit).body)) as {
        token: string;
      };
      expect(body.token).toBe(longToken);
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("surfaces the error inline when manual accept returns ok=false", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeAuthFetch(stub, {
      detect: { found: false },
      accept: { ok: false, error: "invalid jwt" },
    });
    renderWithProviders(<AuthStep onNext={onNext} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);

    await user.type(
      screen.getByPlaceholderText(/bearer eyJ/i),
      "bearer eyJ0000000000000000000000",
    );
    await user.click(screen.getByRole("button", { name: /use this token/i }));

    expect(await screen.findByText(/invalid jwt/i)).toBeInTheDocument();
    expect(onNext).not.toHaveBeenCalled();
  });
});

describe("AuthStep — background watch via EventSource", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    lastEventSource = null;
    installEventSourceStub();
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("'Open web.plaud.ai and watch for login' POSTs to /api/auth/watch and opens an EventSource", async () => {
    const user = userEvent.setup();
    routeAuthFetch(stub, {
      detect: { found: false },
      watch: { watchId: "w-42" },
    });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);
    await user.click(
      screen.getByRole("button", {
        name: /open web\.plaud\.ai and watch for login/i,
      }),
    );

    await waitFor(() => {
      expect(lastEventSource).not.toBeNull();
    });
    expect(lastEventSource!.url).toBe("/api/auth/watch/w-42/events");
    // "Waiting for you to log in…" takes over in place of the button.
    expect(
      await screen.findByText(/waiting for you to log in…/i),
    ).toBeInTheDocument();
  });

  it("receiving type=found closes the stream and calls onNext", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    routeAuthFetch(stub, {
      detect: { found: false },
      watch: { watchId: "w-1" },
    });
    renderWithProviders(<AuthStep onNext={onNext} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);
    await user.click(
      screen.getByRole("button", {
        name: /open web\.plaud\.ai and watch for login/i,
      }),
    );
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    await act(async () => {
      lastEventSource!.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "found" }),
        }),
      );
    });
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(lastEventSource!.close).toHaveBeenCalled();
  });

  it("receiving type=timeout closes the stream and shows the 5-minute timeout error", async () => {
    const user = userEvent.setup();
    routeAuthFetch(stub, {
      detect: { found: false },
      watch: { watchId: "w-1" },
    });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);
    await user.click(
      screen.getByRole("button", {
        name: /open web\.plaud\.ai and watch for login/i,
      }),
    );
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    await act(async () => {
      lastEventSource!.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "timeout" }),
        }),
      );
    });
    expect(
      await screen.findByText(/timed out waiting for login \(5 min\)/i),
    ).toBeInTheDocument();
    expect(lastEventSource!.close).toHaveBeenCalled();
  });

  it("receiving onerror closes the stream and surfaces 'connection lost'", async () => {
    const user = userEvent.setup();
    routeAuthFetch(stub, {
      detect: { found: false },
      watch: { watchId: "w-1" },
    });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);
    await user.click(
      screen.getByRole("button", {
        name: /open web\.plaud\.ai and watch for login/i,
      }),
    );
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    await act(async () => {
      lastEventSource!.onerror?.(new Event("error"));
    });
    expect(
      await screen.findByText(/connection lost/i),
    ).toBeInTheDocument();
    expect(lastEventSource!.close).toHaveBeenCalled();
  });

  it("surfaces an error message when authStartWatch itself fails", async () => {
    const user = userEvent.setup();
    routeAuthFetch(stub, {
      detect: { found: false },
      watch: "throw",
    });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText(/no existing plaud session found/i);
    await user.click(
      screen.getByRole("button", {
        name: /open web\.plaud\.ai and watch for login/i,
      }),
    );
    expect(await screen.findByText(/watch failed/i)).toBeInTheDocument();
    // No EventSource opened if the start call failed.
    expect(lastEventSource).toBeNull();
  });
});

describe("AuthStep — back navigation", () => {
  let stub: ReturnType<typeof stubFetch>;
  beforeEach(() => {
    stub = stubFetch();
    installEventSourceStub();
  });
  afterEach(() => {
    stub.cleanup();
    vi.unstubAllGlobals();
  });

  it("Back button calls onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    routeAuthFetch(stub, { detect: { found: false } });
    renderWithProviders(<AuthStep onNext={vi.fn()} onBack={onBack} />);
    await user.click(
      await screen.findByRole("button", { name: /^back$/i }),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
