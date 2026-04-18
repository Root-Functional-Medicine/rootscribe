import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedInitialState } from "./server/src/test-seed/fixtures.js";

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
const PORT = Number(process.env.ROOTSCRIBE_E2E_PORT ?? DEFAULT_PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Resolve the server process's config dir at Playwright load time.
// seedInitialState() wipes state.sqlite and overwrites settings.json, so we
// MUST NEVER point it at a caller-supplied ROOTSCRIBE_CONFIG_DIR — that
// would clobber a developer's real config if they forgot to unset the env
// var. Always mint a dedicated tmp dir unless the caller opts in via
// ROOTSCRIBE_E2E_ALLOW_CONFIG_DIR=1.
//
// Complication: Playwright re-executes this config file in every worker
// process. On the first load, we mint a dir under `$TMPDIR/rootscribe-e2e-*`
// and set process.env.ROOTSCRIBE_CONFIG_DIR to it. On subsequent re-loads,
// we see our own minted dir in the env and must NOT treat it as a
// "caller-supplied" dir — otherwise every worker throws the guard error.
// Recognize our minted pattern by prefix so re-loads can skip re-minting.
const MINTED_PREFIX = path.join(tmpdir(), "rootscribe-e2e-");
const allowSuppliedDir = process.env.ROOTSCRIBE_E2E_ALLOW_CONFIG_DIR === "1";
const envDir =
  process.env.ROOTSCRIBE_CONFIG_DIR && process.env.ROOTSCRIBE_CONFIG_DIR.length > 0
    ? process.env.ROOTSCRIBE_CONFIG_DIR
    : null;
const isOurMintedDir = envDir !== null && envDir.startsWith(MINTED_PREFIX);

if (envDir && !isOurMintedDir && !allowSuppliedDir) {
  throw new Error(
    `playwright.config.ts refused to seed into ROOTSCRIBE_CONFIG_DIR=${envDir} — ` +
      `seedInitialState() wipes state.sqlite and overwrites settings.json, which would ` +
      `destroy real user data. Unset ROOTSCRIBE_CONFIG_DIR or, if you genuinely want to ` +
      `target that directory (e.g. a throwaway CI scratch dir), set ` +
      `ROOTSCRIBE_E2E_ALLOW_CONFIG_DIR=1 alongside it.`,
  );
}

// "explicit" here = caller-provided and explicitly allowed (either because
// it's one we minted on a previous load, or because the opt-in flag is set).
// Any other existing dir was rejected by the guard above.
const explicitConfigDir = isOurMintedDir || allowSuppliedDir ? envDir : null;
const E2E_CONFIG_DIR = explicitConfigDir ?? mkdtempSync(MINTED_PREFIX);
const shouldSeed = !isOurMintedDir;

// globalTeardown needs to know whether the directory was auto-created so it
// doesn't delete a caller-supplied one. Passed through the environment
// because Playwright's teardown runs in a different process from config load.
// Only set it when WE minted the dir on this load (i.e. first main-process
// load; worker re-loads that see a pre-minted env var don't re-mint).
if (shouldSeed && !allowSuppliedDir) {
  process.env.ROOTSCRIBE_E2E_TEARDOWN_DIR = E2E_CONFIG_DIR;
}

// Make the resolved dir visible to globalSetup and — via `webServer.env` —
// the server subprocess.
process.env.ROOTSCRIBE_CONFIG_DIR = E2E_CONFIG_DIR;

// Seed the config dir HERE, at config-load time, instead of in globalSetup.
// Playwright starts webServer before running globalSetup by default, so any
// seed written there lands AFTER the server's config/db singletons have
// already latched onto an empty settings.json. Writing at config-load time
// guarantees the fixtures exist before `pnpm start:nobuild` / `pnpm dev`
// forks.
//
// Resolve the port Express will bind to, separate from the port Playwright
// connects to:
//   CI: Express serves both SPA + API, so bind.port must equal PORT
//       (which itself honors ROOTSCRIBE_E2E_PORT). Playwright hits Express
//       directly.
//   local dev: Vite's proxy (see web/vite.config.ts) is hard-coded to
//       forward /api and /media to 127.0.0.1:44471. Changing Express's
//       bind.port there would break that proxy. Playwright hits Vite
//       (PORT=44470), which proxies to Express on 44471.
const SERVER_PORT = process.env.CI ? PORT : 44471;
// Skip re-seed on worker re-loads — the main process already seeded, and
// writing here again while the server has open handles on state.sqlite
// risks file-lock errors and database races.
if (shouldSeed) {
  seedInitialState(E2E_CONFIG_DIR, { port: SERVER_PORT });
}

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: path.join(here, "tests", "e2e", "global-setup.ts"),
  globalTeardown: path.join(here, "tests", "e2e", "global-teardown.ts"),
  // Journey specs share a single seeded config dir and mutate it via the
  // server's /api/_test/reset between tests. Running them in parallel would
  // race on the DB handle even with resets, so we serialize. CI already
  // sets workers: 1 for retry determinism; this keeps local runs honest too.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
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
      ROOTSCRIBE_CONFIG_DIR: E2E_CONFIG_DIR,
      // Suppress the server's first-run `open()` call — otherwise every
      // `pnpm test:e2e` invocation pops a setup-wizard browser at the user's
      // desktop on top of (and unrelated to) Playwright's own headless
      // chromium. `--headed` / `--ui` still work for debugging the test
      // browser itself; this flag only silences the app.
      ROOTSCRIBE_NO_OPEN: "1",
      // Enables the /api/_test/* routes so journey specs can reset mutable
      // DB state between tests. server/src/index.ts MUST keep the
      // `process.env.ROOTSCRIBE_E2E === "1"` guard — the routes must never
      // register in a production process.
      ROOTSCRIBE_E2E: "1",
    },
  },
});
