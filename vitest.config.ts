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
      // Baseline (Apr 2026, Vitest 4, post-DEVX-102 ratchet #5):
      // 71.60% lines, 66.06% branches, 79.88% functions, 70.00% statements.
      // Ratchet #5 covered the setup wizard: WelcomeStep / AuthStep /
      // RecordingsDirStep / WebhookStep / JiraStep / ReviewStep +
      // SetupWizard orchestrator (60 new tests). AuthStep exercises all
      // three auth flows (detect/accept, watch via EventSource, manual
      // token paste); SetupWizard walks the full 6-step wizard end-to-end
      // and asserts navigation to "/" after complete-setup. Thresholds
      // sit about 0.6–1.1 points below the achieved numbers (branches
      // has the widest gap at ~1.1; the others cluster around 0.6–1.0).
      // Subsequent DEVX-102 PRs continue bumping each axis toward 95% —
      // remaining 0% clusters are server infrastructure
      // (poller/webhook/auth detection) and inbox-mcp.
      thresholds: {
        lines: 71,
        functions: 79,
        branches: 65,
        statements: 69,
      },
    },
  },
});
