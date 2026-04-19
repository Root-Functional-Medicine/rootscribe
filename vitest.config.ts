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
      // Baseline (Apr 2026, Vitest 4, post-DEVX-102 ratchet #4):
      // 65.13% lines, 57.33% branches, 70.11% functions, 63.39% statements.
      // Ratchet #4 covered the three major web routes (Dashboard,
      // RecordingDetail, Settings). Every test hits the real
      // jsonFetch → fetch pipeline via a stubbed global.fetch; no
      // mock-heavy internals. RecordingDetail exercises the transcript
      // parser, Ctrl+F search, audio play/pause/skip refs, summary modal,
      // delete-confirm flow, and every sidebar editor; Dashboard covers
      // URL-synced filter deep-linking + sync-trigger lifecycle; Settings
      // covers config form + webhook test + server-validation errors.
      // Thresholds sit ~0.5% below the achieved numbers. Subsequent
      // DEVX-102 PRs continue bumping each axis toward 95%.
      thresholds: {
        lines: 64,
        functions: 69,
        branches: 56,
        statements: 62,
      },
    },
  },
});
