import { useState, type ReactElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, type MemoryRouterProps } from "react-router-dom";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { ThemeContext, type Theme } from "./hooks/useTheme.js";

// A Testing Library render wrapper that stitches together the three providers
// every component under test needs:
//   - QueryClientProvider for `useQuery` / `useMutation`
//   - MemoryRouter so `<Link>` + `useLocation` etc. resolve without a browser URL
//   - ThemeContext so `useTheme()` consumers don't crash
//
// Each call gets a FRESH QueryClient by default — per-test isolation means one
// test's cached data or mutation state can't leak into the next. Callers that
// need to seed cache data can pass `queryClient` explicitly.

export interface TestProviderOptions {
  /** Pre-seeded QueryClient (e.g. to test cache invalidation). Defaults to a fresh one. */
  queryClient?: QueryClient;
  /** Initial MemoryRouter entries. Matches the component's expected route. */
  routerEntries?: MemoryRouterProps["initialEntries"];
  /** Theme value to expose via ThemeContext. Defaults to "light". */
  theme?: Theme;
}

export function createTestQueryClient(): QueryClient {
  // Disable retries so a stubbed-rejection doesn't sit in a 3× retry loop
  // before the test can assert on the error state. staleTime: 0 keeps
  // behavior predictable across tests that refetch.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export interface TestProvidersProps extends TestProviderOptions {
  children: ReactNode;
}

export function TestProviders({
  children,
  queryClient,
  routerEntries = ["/"],
  theme = "light",
}: TestProvidersProps): ReactElement {
  // Lazy useState keeps the default client stable across re-renders. Without
  // this, any parent-triggered rerender (Testing Library's `rerender`, a
  // wrapping test harness bumping state) would mint a NEW QueryClient and
  // reset cache / mutation state mid-assertion.
  const [defaultClient] = useState(() => createTestQueryClient());
  const client = queryClient ?? defaultClient;
  const themeValue = {
    theme,
    setTheme: () => undefined,
    toggle: () => undefined,
  };
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={routerEntries}>
        <ThemeContext.Provider value={themeValue}>{children}</ThemeContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export interface RenderWithProvidersOptions extends TestProviderOptions {
  /** Passed straight through to Testing Library's render(). */
  renderOptions?: Omit<RenderOptions, "wrapper">;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const result = render(ui, {
    ...options.renderOptions,
    wrapper: ({ children }) => (
      <TestProviders
        queryClient={queryClient}
        routerEntries={options.routerEntries}
        theme={options.theme}
      >
        {children}
      </TestProviders>
    ),
  });
  return { ...result, queryClient };
}

// Per-test fetch stub — matches the pattern already in use by api.test.ts. The
// returned mock replaces global.fetch until cleanup() runs; call cleanup in
// afterEach to restore the real fetch.
export interface FetchStub {
  fetch: ReturnType<typeof vi.fn>;
  cleanup: () => void;
}

// Re-export vi types so callers don't need to import vitest themselves for
// the mock shape in this module's type signature.
import { vi } from "vitest";

export function stubFetch(): FetchStub {
  // Capture the original global so cleanup restores ONLY fetch. Using
  // vi.unstubAllGlobals() here would also blow away unrelated stubs set up
  // by the same test (EventSource, matchMedia, etc.), making suites
  // order-dependent. Scope the restoration tightly.
  const originalFetch = globalThis.fetch;
  const mock = vi.fn();
  vi.stubGlobal("fetch", mock);
  return {
    fetch: mock,
    cleanup: () => {
      if (originalFetch) {
        globalThis.fetch = originalFetch;
      } else {
        // If fetch wasn't defined before (unusual — happy-dom provides one),
        // drop the stub entirely.
        // @ts-expect-error — intentionally removing the polyfilled global.
        delete globalThis.fetch;
      }
    },
  };
}

/** Build a typed JSON Response for stubbed fetch returns. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "application/json" },
  });
}
