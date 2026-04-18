import type { UserConfig } from "vitest/config";

// Common exclude patterns shared across every package's unit/integration runs.
// Playwright specs live under tests/e2e and must not be discovered by Vitest.
export const sharedExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/tests/e2e/**",
  "**/playwright-report/**",
  "**/test-results/**",
];

// Files that should not count toward coverage — entrypoints, type-only
// modules, and generated output. Each package can extend this as needed.
export const sharedCoverageExclude = [
  ...sharedExclude,
  "**/*.config.{ts,js,mjs}",
  "**/vitest.setup.ts",
  "**/index.ts",
  "**/main.tsx",
  "**/*.d.ts",
  "**/types.ts",
];

export function baseTestConfig(): NonNullable<UserConfig["test"]> {
  return {
    exclude: sharedExclude,
    passWithNoTests: false,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: process.env.CI ? { junit: "test-results/junit.xml" } : undefined,
  };
}
