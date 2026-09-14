import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type Express } from "express";
import { afterAll, beforeAll } from "vitest";

// Each suite gets its own ROOTSCRIBE_CONFIG_DIR rooted in /tmp so the real
// user config in ~/Library/Application Support/rootscribe stays untouched.
// The env var is set BEFORE the caller imports any server module, because
// server/src/paths.ts reads it lazily on first call and server/src/config.ts
// caches the parsed settings at module load.
export function mkTempConfigDir(prefix = "rootscribe-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.ROOTSCRIBE_CONFIG_DIR = dir;
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

// Wrap a test app in an http.Server bound to 127.0.0.1:0 and hand the
// listening server to supertest instead of the bare Express app.
//
// Why not just `request(app)`? supertest then calls `app.listen(0)` with no
// host, which binds the dual-stack IPv6 wildcard `[::]:0`. On macOS the
// kernel's ephemeral-port picker only checks for conflicts within the same
// address family, so `[::]:P` can succeed while another process already
// holds `127.0.0.1:P` (IDE helpers, local agents, Postman, etc. all sit in
// the 49152-65535 range). supertest then connects to 127.0.0.1:P and the
// kernel routes that to the more-specific foreign listener — the Express
// app never sees the request and the test asserts against whatever the
// foreign process returned (404, 503, 401...). Binding 127.0.0.1 explicitly
// puts the picker in the right family, so the port is guaranteed to be ours.
// Linux rejects the cross-family overlap with EADDRINUSE, which is why CI
// never reproduced it.
//
// Registers beforeAll/afterAll on the calling suite, so call it at module
// scope (or inside a describe) — never inside `it`. The returned server is
// not listening until beforeAll runs; `request(server)` inside a test is
// fine because supertest reads `server.address()` lazily per request.
export function startTestServer(mount: (app: Express) => void): Server {
  const server = createServer(makeTestApp(mount));

  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  return server;
}
