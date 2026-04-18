import { defineConfig } from "vitest/config";
import { sharedCoverageExclude } from "./vitest.shared.js";

// Root-level Vitest config for options that must be global across the
// workspace: coverage aggregation and thresholds. Per-project test behavior
// (environment, resolve aliases, setup files) lives in each package's
// vitest.config.ts, which the workspace file discovers.
//
// Coverage thresholds are the BASELINE we currently achieve (DEVX-100 was
// scoped as "infrastructure + baseline tests"). The ratcheting plan lives in
// DEVX-102 (the 95%-coverage follow-up Story) — bump each threshold +5% per
// PR there until all sit >= 95%.
export default defineConfig({
  test: {
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
      // Current baseline (Apr 2026): 19% lines, 78% branches, 28% functions.
      // Thresholds sit slightly below baseline so drops caused by untested
      // additions fail CI without false-alarming on minor coverage noise.
      // The follow-up Story for reaching 95% ratchets these up each PR.
      thresholds: {
        lines: 18,
        functions: 27,
        branches: 75,
        statements: 18,
      },
    },
  },
});
