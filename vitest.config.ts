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
      // Baseline (Apr 2026, Vitest 4, post-DEVX-102 ratchet #7):
      // 94.53% lines, 82.75% branches, 93.37% functions, 92.47% statements.
      // Ratchet #7 is the final tightening: plaud/client (0% → 100%),
      // plaud/transcript (28% → 100%), routes/config /test-webhook +
      // /validate-recordings-dir + /complete-setup branches, server
      // paths.ts + inbox-mcp db.ts platform + file-read branches.
      // 68 new tests.
      //
      // Three axes (lines / functions / statements) are very close to the
      // 95% target — ~0.5–2.5 pts headroom each. Branches remains the
      // laggard at 82.75% because the hardest-to-hit branches are
      // WSL-specific (profiles.ts wslWindowsUsernames), SVG-geometry
      // fallbacks (Waveform.tsx path generation), and heavy-mock
      // coverage-gap cases that need dedicated follow-up. Thresholds sit
      // ~0.5 pts below achieved on every axis. DEVX-102 stays open for
      // one more small pass on branches after merge.
      thresholds: {
        lines: 94,
        functions: 93,
        branches: 82,
        statements: 92,
      },
    },
  },
});
