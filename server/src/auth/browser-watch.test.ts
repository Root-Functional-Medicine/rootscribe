import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoundToken } from "./chrome-leveldb.js";
import type { WatchEvent } from "./browser-watch.js";

// Mock findToken: every test stages an ordered sequence of return values
// (baseline + subsequent polls). The mock walks the sequence, then sticks
// on the last value (common case: stay on `null` forever unless the test
// pushes a found token).
vi.mock("./chrome-leveldb.js", () => ({
  findToken: vi.fn(),
}));

// Mock the `open` package (ESM default export) — tests verify it's called
// with the right URL or that openBrowser=false skips it entirely.
vi.mock("open", () => ({
  default: vi.fn(),
}));

const { startBrowserWatch, subscribeWatch, stopWatch } = await import(
  "./browser-watch.js"
);
const { findToken } = await import("./chrome-leveldb.js");
const openUrl = (await import("open")).default;

function tokenFor(id: string, iat = 1_700_000_000): FoundToken {
  return {
    token: `token-${id}`,
    browser: "Chrome",
    profile: "Default",
    email: `${id}@example.com`,
    iat,
    exp: iat + 3600,
  };
}

beforeEach(() => {
  vi.mocked(findToken).mockReset();
  vi.mocked(openUrl).mockReset();
  // Fake only the timer surface we need. Keeping Date real so the
  // startedAt / elapsedMs math continues to advance under
  // vi.advanceTimersByTimeAsync.
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startBrowserWatch — baseline + browser open", () => {
  it("resolves with a UUID watch id", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    const id = await startBrowserWatch(false);
    // UUID v4 shape: 8-4-4-4-12 hex chars.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    stopWatch(id);
  });

  it("calls open() with https://web.plaud.ai/ when openBrowser=true", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    const id = await startBrowserWatch(true);
    expect(openUrl).toHaveBeenCalledWith("https://web.plaud.ai/");
    stopWatch(id);
  });

  it("skips open() when openBrowser=false", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    const id = await startBrowserWatch(false);
    expect(openUrl).not.toHaveBeenCalled();
    stopWatch(id);
  });

  it("emits {type:'error', message} when open() rejects", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    vi.mocked(openUrl).mockRejectedValue(new Error("no default browser"));

    const id = await startBrowserWatch(true);
    // Give the emit() a microtask to fire after the open() rejection settles.
    const events: WatchEvent[] = [];
    const unsub = subscribeWatch(id, (e) => events.push(e));
    expect(unsub).not.toBeNull();

    // The error is emitted synchronously inside startBrowserWatch (before
    // the poll interval kicks in), so the replayed lastEvent on subscribe
    // surfaces it immediately.
    expect(events).toContainEqual({
      type: "error",
      message: "failed to open browser: no default browser",
    });
    stopWatch(id);
    unsub!();
  });

  it("does not emit 'found' when findToken returns the baseline (already-logged-in) token", async () => {
    const baseline = tokenFor("baseline");
    // Return the same baseline on every subsequent poll.
    vi.mocked(findToken).mockResolvedValue(baseline);

    const id = await startBrowserWatch(false);
    const events: WatchEvent[] = [];
    subscribeWatch(id, (e) => events.push(e));

    // Advance past several poll intervals (2s apart). The baseline token
    // should be ignored each time.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.some((e) => e.type === "found")).toBe(false);
    stopWatch(id);
  });
});

describe("startBrowserWatch — found event", () => {
  it("emits {type:'found'} when a NEW token appears after the baseline", async () => {
    const newer = tokenFor("newer", 1_800_000_000);
    // Baseline: null (no existing session). Subsequent polls: newer token.
    vi.mocked(findToken)
      .mockResolvedValueOnce(null) // baseline
      .mockResolvedValue(newer);

    const id = await startBrowserWatch(false);
    const events: WatchEvent[] = [];
    subscribeWatch(id, (e) => events.push(e));

    // The immediate post-baseline poll fires inside startBrowserWatch via
    // `void poll()`. Let the microtask settle, then advance timers so any
    // interval-driven re-poll or heartbeat also runs.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(events).toContainEqual({ type: "found", token: newer });
    // After "found" the watch is stopped — no further heartbeats.
    const countBefore = events.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.length).toBe(countBefore);
  });

  it("ignores a findToken() rejection during polling (logs + retries next tick)", async () => {
    const newer = tokenFor("newer-after-error");
    vi.mocked(findToken)
      .mockResolvedValueOnce(null) // baseline
      .mockRejectedValueOnce(new Error("leveldb locked")) // first poll fails
      .mockResolvedValue(newer); // subsequent polls find the new token

    const id = await startBrowserWatch(false);
    const events: WatchEvent[] = [];
    subscribeWatch(id, (e) => events.push(e));

    // Kick past the first (failed) immediate poll + the next interval poll
    // that should succeed.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(events).toContainEqual({ type: "found", token: newer });
    stopWatch(id);
  });
});

describe("startBrowserWatch — heartbeats + timeout", () => {
  it("emits {type:'waiting'} on the 5s heartbeat interval", async () => {
    vi.mocked(findToken).mockResolvedValue(null);

    const id = await startBrowserWatch(false);
    const events: WatchEvent[] = [];
    subscribeWatch(id, (e) => events.push(e));

    await vi.advanceTimersByTimeAsync(5_100);
    const waiting = events.filter((e) => e.type === "waiting");
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    expect((waiting[0] as Extract<WatchEvent, { type: "waiting" }>).elapsedMs)
      .toBeGreaterThanOrEqual(5_000);
    stopWatch(id);
  });

  it("emits {type:'timeout'} after 5 minutes + stops emitting heartbeats", async () => {
    vi.mocked(findToken).mockResolvedValue(null);

    const id = await startBrowserWatch(false);
    const events: WatchEvent[] = [];
    subscribeWatch(id, (e) => events.push(e));

    // Jump right to the timeout boundary.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

    expect(events).toContainEqual({ type: "timeout" });
    // After timeout, no additional heartbeats.
    const beforeExtra = events.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.length).toBe(beforeExtra);
  });
});

describe("subscribeWatch / stopWatch", () => {
  it("returns null from subscribeWatch for an unknown watch id", () => {
    expect(subscribeWatch("nonexistent", () => undefined)).toBeNull();
  });

  it("stopWatch returns false for an unknown id, true for a real one", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    const id = await startBrowserWatch(false);
    expect(stopWatch("nonexistent")).toBe(false);
    expect(stopWatch(id)).toBe(true);
  });

  it("replays the last event to a late subscriber so they see current state", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    const id = await startBrowserWatch(false);

    // Let one heartbeat fire first.
    await vi.advanceTimersByTimeAsync(5_100);

    // Late subscriber joins after the heartbeat — should receive it
    // immediately on subscribe thanks to the lastEvent replay.
    const late: WatchEvent[] = [];
    subscribeWatch(id, (e) => late.push(e));
    expect(late.length).toBe(1);
    expect(late[0]!.type).toBe("waiting");
    stopWatch(id);
  });

  it("unsubscribe removes the listener and subsequent events are not delivered to it", async () => {
    vi.mocked(findToken).mockResolvedValue(null);
    const id = await startBrowserWatch(false);

    const events: WatchEvent[] = [];
    const unsub = subscribeWatch(id, (e) => events.push(e))!;
    await vi.advanceTimersByTimeAsync(5_100);
    const afterFirst = events.length;
    unsub();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(events.length).toBe(afterFirst);
    stopWatch(id);
  });
});
