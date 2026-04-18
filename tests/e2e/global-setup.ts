import { seedInitialState } from "../../server/src/test-seed/fixtures.js";

// Runs once before Playwright starts webServer. The config dir was created
// at playwright.config.ts load time and exported via ROOTSCRIBE_CONFIG_DIR
// (in this process) + webServer.env (for the server subprocess). Seeding
// here — BEFORE webServer boots — means server/src/config.ts's lazy load
// sees our settings.json on first hit and db.ts's lazy getDb() opens our
// pre-populated state.sqlite.
//
// If we seeded AFTER webServer started, the server process would have
// already cached an empty config + opened an empty DB, and no amount of
// on-disk changes would repair it short of process restart.

export default async function globalSetup(): Promise<void> {
  const configDir = process.env.ROOTSCRIBE_CONFIG_DIR;
  if (!configDir) {
    throw new Error(
      "global-setup expected ROOTSCRIBE_CONFIG_DIR to be set by playwright.config.ts",
    );
  }
  seedInitialState(configDir);
}
