import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.APPLAUD_E2E_PORT ?? 44471);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Resolve the server process's config dir at Playwright load time. If the
// caller (CI, local dev) explicitly set APPLAUD_CONFIG_DIR, honor it —
// otherwise mint a disposable tmp dir. We must NEVER pass an empty string
// to the server: server/src/paths.ts treats an empty APPLAUD_CONFIG_DIR as
// "unset" and falls back to ~/Library/Application Support/applaud, which
// would let local E2E runs read and mutate the user's real settings.json.
const E2E_CONFIG_DIR =
  process.env.APPLAUD_CONFIG_DIR && process.env.APPLAUD_CONFIG_DIR.length > 0
    ? process.env.APPLAUD_CONFIG_DIR
    : mkdtempSync(path.join(tmpdir(), "applaud-e2e-"));

export default defineConfig({
  testDir: "./tests/e2e",
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
    // CI builds once and runs the production server; local runs use the
    // dev server (vite + express) so hot-reload and source maps stay live.
    command: process.env.CI ? "pnpm start" : "pnpm dev",
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
