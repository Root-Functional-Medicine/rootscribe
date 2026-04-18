import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type Express } from "express";

// Each suite gets its own APPLAUD_CONFIG_DIR rooted in /tmp so the real
// user config in ~/Library/Application Support/applaud stays untouched.
// The env var is set BEFORE the caller imports any server module, because
// server/src/paths.ts reads it lazily on first call and server/src/config.ts
// caches the parsed settings at module load.
export function mkTempConfigDir(prefix = "applaud-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.APPLAUD_CONFIG_DIR = dir;
  return dir;
}

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort — if cleanup fails (e.g. a file handle is still open on
    // Windows CI), the OS temp cleanup will handle it eventually.
  }
}

// Mount a router on a minimal Express app with JSON body parsing. Matches the
// real production setup in server/src/index.ts (`app.use(express.json(...))`,
// `app.disable("x-powered-by")`) so supertest exercises the same middleware
// stack a real client would hit.
export function makeTestApp(mount: (app: Express) => void): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  mount(app);
  return app;
}
