import { seedInitialState } from "../../server/src/test-seed/fixtures.js";

// The initial seed happens in playwright.config.ts (before webServer boots).
// globalSetup is a no-op on the primary path but re-runs the seed anyway so
// a developer who toggled --ui or --repeat-each gets a fresh dir on retry.
// The /api/_test/reset handler covers between-test resets inside a single
// run; this covers across-run isolation.

export default async function globalSetup(): Promise<void> {
  const configDir = process.env.ROOTSCRIBE_CONFIG_DIR;
  if (!configDir) {
    throw new Error(
      "global-setup expected ROOTSCRIBE_CONFIG_DIR to be set by playwright.config.ts",
    );
  }
  seedInitialState(configDir);
}
