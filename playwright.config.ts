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
const rawPort = process.env.ROOTSCRIBE_E2E_PORT ?? String(DEFAULT_PORT);
const PORT = Number(rawPort);
// Reject non-integer / out-of-range ports loudly. Without this,
// `Number("not-a-number")` silently yields NaN, which propagates into
// BASE_URL ("http://127.0.0.1:NaN"), SERVER_PORT, and settings.json's
// bind.port — turning a typo into a cryptic E2E startup failure.
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(
    `Invalid ROOTSCRIBE_E2E_PORT: ${rawPort}. Expected an integer between 1 and 65535.`,
  );
}
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Resolve the server process's config dir at Playwright load time.
// seedInitialState() wipes state.sqlite and overwrites settings.json, so we
// MUST NEVER point it at a caller-supplied ROOTSCRIBE_CONFIG_DIR — that
// would clobber a developer's real config if they forgot to unset the env
// var. Always mint a dedicated tmp dir unless the caller opts in via
// ROOTSCRIBE_E2E_ALLOW_CONFIG_DIR=1.
//
// Complication: Playwright re-executes this config file in every worker
// process. We must seed exactly ONCE per run — re-seeding in a worker while
// the server has open handles on state.sqlite causes file-lock / database
// races. Track whether the first load has already seeded via
// ROOTSCRIBE_E2E_ALREADY_SEEDED, which inherits into workers from the main
// process's env. The minted-prefix check only catches the no-env case; the
// sentinel covers BOTH no-env and explicitly-allowed caller-supplied paths.
const MINTED_PREFIX = path.join(tmpdir(), "rootscribe-e2e-");
const ALREADY_SEEDED_FLAG = "ROOTSCRIBE_E2E_ALREADY_SEEDED";

// Windows path comparisons need normalization + case-folding: `$env:TEMP`
// could be `C:\Users\...\Temp` in one place and `c:/users/.../temp` in
// another (forward slashes / different casing). Without normalization, a
// self-minted dir can get misclassified as caller-supplied — triggering
// the guard or skipping teardown cleanup.
function normalizePathForComparison(dir: string): string {
  const normalized = path.normalize(path.resolve(dir));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
const normalizedMintedPrefix = normalizePathForComparison(MINTED_PREFIX);

const allowSuppliedDir = process.env.ROOTSCRIBE_E2E_ALLOW_CONFIG_DIR === "1";
const alreadySeeded = process.env[ALREADY_SEEDED_FLAG] === "1";
const envDir =
  process.env.ROOTSCRIBE_CONFIG_DIR && process.env.ROOTSCRIBE_CONFIG_DIR.length > 0
    ? process.env.ROOTSCRIBE_CONFIG_DIR
    : null;
const isOurMintedDir =
  envDir !== null &&
  normalizePathForComparison(envDir).startsWith(normalizedMintedPrefix);

if (envDir && !isOurMintedDir && !allowSuppliedDir) {
  throw new Error(
    `playwright.config.ts refused to seed into ROOTSCRIBE_CONFIG_DIR=${envDir} — ` +
      `seedInitialState() wipes state.sqlite and overwrites settings.json, which would ` +
      `destroy real user data. Unset ROOTSCRIBE_CONFIG_DIR or, if you genuinely want to ` +
      `target that directory (e.g. a throwaway CI scratch dir), set ` +
      `ROOTSCRIBE_E2E_ALLOW_CONFIG_DIR=1 alongside it.`,
  );
}

// Did the caller supply this directory, or did we mint it? This drives
// teardown ownership: we only delete what we minted. Note that
// allowSuppliedDir alone isn't enough — a caller could set the allow flag
// without setting ROOTSCRIBE_CONFIG_DIR, in which case we mint and own the
// dir normally.
const callerSuppliedDir = envDir !== null && !isOurMintedDir;
const E2E_CONFIG_DIR = envDir ?? mkdtempSync(MINTED_PREFIX);
const shouldSeed = !alreadySeeded;

// globalTeardown needs to know whether the directory was auto-created so it
// doesn't delete a caller-supplied one. Passed through the environment
// because Playwright's teardown runs in a different process from config load.
// Only mark it for teardown when WE minted it (i.e. caller didn't supply).
if (shouldSeed && !callerSuppliedDir) {
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
// risks file-lock errors and database races. The sentinel is set AFTER
// seeding completes so a throw mid-seed still retries on next load.
if (shouldSeed) {
  seedInitialState(E2E_CONFIG_DIR, { port: SERVER_PORT });
  process.env[ALREADY_SEEDED_FLAG] = "1";
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
