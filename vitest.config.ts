import { defineConfig } from "vitest/config";
import { sharedCoverageExclude } from "./vitest.shared.js";

// Root-level Vitest config for options that must be global across the
// workspace: coverage aggregation and thresholds, plus the list of per-project
// configs. Vitest 4 replaced the standalone `vitest.workspace.*` file with the
// inline `projects` array here — per-project test behavior (environment,
// resolve aliases, setup files) still lives in each package's vitest.config.ts.
//
// Coverage thresholds are the BASELINE we currently achieve (DEVX-100 was
// scoped as "infrastructure + baseline tests"). The ratcheting plan lives in
// DEVX-102 (the 95%-coverage follow-up Story) — bump each threshold +5% per
// PR there until all sit >= 95%.
export default defineConfig({
  test: {
    projects: [
      "./shared/vitest.config.ts",
      "./server/vitest.config.ts",
      "./web/vitest.config.ts",
      "./inbox-mcp/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "shared/src/**/*.ts",
        "server/src/**/*.ts",
        "web/src/**/*.{ts,tsx}",
        "inbox-mcp/src/**/*.ts",
      ],
      exclude: [
        ...sharedCoverageExclude,
        // Type-only modules contribute no executable lines; counting them
        // skews the percentage without reflecting real behavior.
        "shared/src/api.ts",
        "shared/src/recording.ts",
        // Server entrypoint binds ports and process signals — covered by
        // Playwright smoke tests, not Vitest.
        "server/src/index.ts",
        // Web entrypoint mounts React; covered by Playwright.
        "web/src/main.tsx",
        "web/src/App.tsx",
        // (Tailwind 4 is CSS-first — no JS config files to exclude.)
      ],
      // Baseline (Apr 2026, Vitest 4, post-DEVX-102 ratchet #1):
      // 19.44% lines, 12.49% branches, 19.27% functions, 18.83% statements.
      // DEVX-102 ratchet #1 added unit tests for the server's pure-function
      // + thin-HTTP-wrapper cluster (sync/events, sync/layout, auth/profiles,
      // plaud/{list,audio,detail}) plus test-seam code (db.resetDbSingleton,
      // routes/_test, test-seed/fixtures) and a supertest/Playwright harness
      // against the E2E-gated test routes. Thresholds sit ~0.5% below the
      // achieved numbers so drops from untested additions fail CI without
      // false-alarming on minor coverage noise. Subsequent DEVX-102 PRs will
      // continue bumping each axis toward 95%.
      thresholds: {
        lines: 19,
        functions: 19,
        branches: 12,
        statements: 18,
      },
    },
  },
});
