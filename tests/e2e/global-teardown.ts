import { rmSync } from "node:fs";

// Runs after all Playwright tests complete. Only removes the APPLAUD config
// directory if Playwright itself auto-created it (i.e. the caller did not
// set APPLAUD_CONFIG_DIR). The marker env var is written in
// playwright.config.ts during config load and intentionally left unset when
// the caller supplied their own directory, so a user's long-lived scratch
// dir is never deleted out from under them.
export default async function globalTeardown(): Promise<void> {
  const tearDir = process.env.APPLAUD_E2E_TEARDOWN_DIR;
  if (!tearDir) return;

  try {
    rmSync(tearDir, { recursive: true, force: true });
  } catch {
    // Best-effort — on Windows the server process may still hold a handle
    // on state.sqlite momentarily after shutdown. The OS temp cleanup will
    // pick up any stragglers, so we don't want teardown to fail the run.
  }
}
