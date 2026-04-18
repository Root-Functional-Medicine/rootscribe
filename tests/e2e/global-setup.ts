import type { FullConfig } from "@playwright/test";

// playwright.config.ts seeds settings.json + state.sqlite BEFORE webServer
// boots (module-load time), so the server subprocess sees the fixture on
// first config read. This hook runs AFTER webServer is up — its only job
// is to *validate* that the server we're about to drive is the E2E-gated
// one we seeded, not a stray `pnpm dev` process Playwright's
// reuseExistingServer latched onto.
//
// Previously this function also called seedInitialState(configDir), which
// was harmful on two fronts:
//   1) It ran after the server had already opened a handle on state.sqlite,
//      so the seed's wipe-and-recreate could yank the DB file out from
//      under a live handle (Windows file-lock crash, or the server
//      pointing at a deleted inode on macOS/Linux).
//   2) It always seeded with DEFAULT_BIND_PORT, which overwrote the
//      correctly-scoped port written at config-load time whenever CI runs
//      with ROOTSCRIBE_E2E_PORT set.

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.webServer?.url;
  if (!baseURL) {
    throw new Error(
      "global-setup could not resolve webServer.url — expected playwright.config.ts to configure webServer.",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseURL}/api/_test/reset`, { method: "POST" });
  } catch (err) {
    throw new Error(
      `global-setup failed to reach ${baseURL}/api/_test/reset. ` +
        `The webServer at ${baseURL} isn't responding. Check the ` +
        `[WebServer] output above for startup errors.`,
      { cause: err },
    );
  }

  if (response.status === 404) {
    throw new Error(
      `global-setup: POST ${baseURL}/api/_test/reset returned 404. ` +
        `This usually means Playwright reused an existing server that was NOT started with ROOTSCRIBE_E2E=1 ` +
        `(commonly, a separately-running \`pnpm dev\`). Either stop that server and let Playwright spawn its own, ` +
        `or set reuseExistingServer=false in playwright.config.ts.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `global-setup: POST ${baseURL}/api/_test/reset returned HTTP ${response.status}. ` +
        `Expected 200 — the E2E test routes exist but the reset failed. Check server logs.`,
    );
  }
}
