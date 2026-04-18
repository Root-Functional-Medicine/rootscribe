import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Locally `pnpm dev` starts Vite on 44470 (serving the SPA) and Express on
// 44471 (serving /api + /media, proxied through Vite). In dev mode the Express
// server doesn't serve the SPA — requests to `/` return 503 because web/dist
// doesn't exist. In CI we run the production build via `pnpm start:nobuild`,
// where Express serves both the SPA bundle and the API on 44471. So the port
// we point Playwright at depends on which server is serving the SPA:
//   CI → Express with built SPA → 44471
//   local → Vite dev server (proxies /api) → 44470
const DEFAULT_PORT = process.env.CI ? 44471 : 44470;
const PORT = Number(process.env.APPLAUD_E2E_PORT ?? DEFAULT_PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Resolve the server process's config dir at Playwright load time. If the
// caller (CI, local dev) explicitly set APPLAUD_CONFIG_DIR, honor it —
// otherwise mint a disposable tmp dir. We must NEVER pass an empty string
// to the server: server/src/paths.ts treats an empty APPLAUD_CONFIG_DIR as
// "unset" and falls back to ~/Library/Application Support/applaud, which
// would let local E2E runs read and mutate the user's real settings.json.
const explicitConfigDir =
  process.env.APPLAUD_CONFIG_DIR && process.env.APPLAUD_CONFIG_DIR.length > 0
    ? process.env.APPLAUD_CONFIG_DIR
    : null;

const E2E_CONFIG_DIR = explicitConfigDir ?? mkdtempSync(path.join(tmpdir(), "applaud-e2e-"));

// globalTeardown needs to know whether the directory was auto-created so it
// doesn't delete a caller-supplied one. Passed through the environment
// because Playwright's teardown runs in a different process from config load.
if (!explicitConfigDir) {
  process.env.APPLAUD_E2E_TEARDOWN_DIR = E2E_CONFIG_DIR;
}

export default defineConfig({
  testDir: "./tests/e2e",
  globalTeardown: path.join(here, "tests", "e2e", "global-teardown.ts"),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // CI runs `pnpm build` as a dedicated step before Playwright starts, so
    // `start:nobuild` skips the redundant `pnpm build` that `start` would
    // otherwise re-run. Local runs use the dev server (vite + express) so
    // hot-reload and source maps stay live.
    command: process.env.CI ? "pnpm start:nobuild" : "pnpm dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      APPLAUD_CONFIG_DIR: E2E_CONFIG_DIR,
    },
  },
});
