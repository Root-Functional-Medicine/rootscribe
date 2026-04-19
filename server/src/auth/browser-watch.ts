import { randomUUID } from "node:crypto";
import openUrl from "open";
import { findToken, type FoundToken } from "./chrome-leveldb.js";
import { logger } from "../logger.js";

export type WatchEvent =
  | { type: "waiting"; elapsedMs: number }
  | { type: "found"; token: FoundToken }
  | { type: "timeout" }
  | { type: "error"; message: string };

type Listener = (e: WatchEvent) => void;

interface Watch {
  id: string;
  startedAt: number;
  listeners: Set<Listener>;
  stop: () => void;
  done: boolean;
  lastEvent: WatchEvent | null;
  baselineTokens: Set<string>;
}

const watches = new Map<string, Watch>();

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5_000;

export async function startBrowserWatch(openBrowser = true): Promise<string> {
  const id = randomUUID();
  const startedAt = Date.now();

  // Snapshot any currently-valid tokens so we can ignore them and detect NEW logins.
  // This matters if the user already had a session but chose "log in again" or "different account."
  const baseline = await findToken().catch(() => null);
  const baselineTokens = new Set<string>();
  if (baseline) baselineTokens.add(baseline.token);

  const listeners = new Set<Listener>();

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;

  // Declare the watch object BEFORE emit()/stop()/poll() so those closures
  // can mutate `watch.lastEvent` / `watch.done` directly. Previously the
  // closures updated local `let` bindings while the watch object held a
  // stale snapshot, so subscribeWatch's lastEvent-replay never saw any
  // events emitted before the subscriber joined.
  const watch: Watch = {
    id,
    startedAt,
    listeners,
    stop: () => undefined,
    done: false,
    lastEvent: null,
    baselineTokens,
  };

  const emit = (e: WatchEvent): void => {
    watch.lastEvent = e;
    for (const l of listeners) {
      try {
        l(e);
      } catch (err) {
        logger.warn({ err }, "watch listener threw");
      }
    }
  };

  const stop = (): void => {
    if (watch.done) return;
    watch.done = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // Schedule cleanup 30s from NOW (not TIMEOUT_MS + 30s from start) so a
    // watch that stops early — e.g., user logs in at second 10 — doesn't
    // hold a phantom entry in the `watches` map for the full 5.5 minutes.
    // Also tracked via `cleanupTimer` so a re-stop can't double-schedule.
    if (!cleanupTimer) {
      cleanupTimer = setTimeout(() => {
        watches.delete(id);
      }, 30_000);
    }
  };
  watch.stop = stop;

  const poll = async (): Promise<void> => {
    try {
      const found = await findToken();
      if (!found) return;
      if (baselineTokens.has(found.token)) return; // same token we started with
      emit({ type: "found", token: found });
      stop();
    } catch (err) {
      logger.warn({ err }, "browser-watch poll error");
    }
  };

  watches.set(id, watch);

  // Heartbeat "waiting" events for the UI.
  heartbeatTimer = setInterval(() => {
    if (watch.done) return;
    emit({ type: "waiting", elapsedMs: Date.now() - startedAt });
  }, HEARTBEAT_INTERVAL_MS);

  pollTimer = setInterval(() => {
    if (!watch.done) void poll();
  }, POLL_INTERVAL_MS);

  timeoutTimer = setTimeout(() => {
    if (!watch.done) {
      emit({ type: "timeout" });
      stop();
    }
  }, TIMEOUT_MS);

  if (openBrowser) {
    try {
      await openUrl("https://web.plaud.ai/");
    } catch (err) {
      emit({
        type: "error",
        message: `failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Fire an immediate poll so we don't wait the full interval.
  void poll();

  // Cleanup is scheduled lazily inside stop() — 30s after the watch
  // actually finishes, so late subscribers can still fetch the last
  // event without phantom entries accumulating when users start/stop
  // watches repeatedly.

  return id;
}

// Listener type exported so SSE consumers (routes/auth) and tests can
// reference the same shape the module emits.
export type { Listener };

export function subscribeWatch(id: string, listener: Listener): (() => void) | null {
  const w = watches.get(id);
  if (!w) return null;
  w.listeners.add(listener);
  // Replay the last event so a late subscriber gets current state.
  if (w.lastEvent) listener(w.lastEvent);
  return () => {
    w.listeners.delete(listener);
  };
}

export function stopWatch(id: string): boolean {
  const w = watches.get(id);
  if (!w) return false;
  w.stop();
  return true;
}
