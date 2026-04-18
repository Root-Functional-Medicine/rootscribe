import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncEvent } from "@rootscribe/shared";
import { emit, syncEvents } from "./events.js";

// syncEvents is a module-level singleton, so listeners attached by one test
// would deliver events to the next test unless we clean up. Each test that
// subscribes pushes its unsubscribe here, and afterEach drains the stack.
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("emit", () => {
  it("delivers an event with the given type to subscribers", () => {
    const received: SyncEvent[] = [];
    cleanups.push(syncEvents.onEvent((e) => received.push(e)));

    emit("poll_start");

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("poll_start");
  });

  it("stamps the `at` field with the current time in milliseconds", () => {
    const frozen = Date.UTC(2026, 3, 18, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(frozen);

    const received: SyncEvent[] = [];
    cleanups.push(syncEvents.onEvent((e) => received.push(e)));

    emit("poll_end");

    expect(received[0].at).toBe(frozen);
    vi.restoreAllMocks();
  });

  it("forwards optional fields (recordingId, message) through the `extra` parameter", () => {
    const received: SyncEvent[] = [];
    cleanups.push(syncEvents.onEvent((e) => received.push(e)));

    emit("recording_new", { recordingId: "abc123", message: "fresh upload" });

    expect(received[0]).toMatchObject({
      type: "recording_new",
      recordingId: "abc123",
      message: "fresh upload",
    });
  });

  it("lets `extra.at` override the default Date.now() timestamp (documented behavior)", () => {
    // The spread in events.ts is `{ type, at: Date.now(), ...extra }`, which
    // means a caller passing `extra.at` wins. Replay scenarios (e.g. restoring
    // state from a persisted event log) depend on this override.
    const received: SyncEvent[] = [];
    cleanups.push(syncEvents.onEvent((e) => received.push(e)));

    emit("poll_start", { at: 1 });

    expect(received[0].at).toBe(1);
  });
});

describe("syncEvents.onEvent", () => {
  it("returns an unsubscribe function that stops further deliveries", () => {
    const received: SyncEvent[] = [];
    const unsubscribe = syncEvents.onEvent((e) => received.push(e));

    emit("poll_start");
    unsubscribe();
    emit("poll_end");

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("poll_start");
  });

  it("fans out to every registered listener", () => {
    const a: SyncEvent[] = [];
    const b: SyncEvent[] = [];
    cleanups.push(syncEvents.onEvent((e) => a.push(e)));
    cleanups.push(syncEvents.onEvent((e) => b.push(e)));

    emit("error", { message: "boom" });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].message).toBe("boom");
    expect(b[0].message).toBe("boom");
  });

  it("unsubscribing one listener does not affect others", () => {
    const kept: SyncEvent[] = [];
    const dropped: SyncEvent[] = [];
    cleanups.push(syncEvents.onEvent((e) => kept.push(e)));
    const unsubscribe = syncEvents.onEvent((e) => dropped.push(e));

    unsubscribe();
    emit("auth_required");

    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });
});

describe("syncEvents.emitEvent", () => {
  it("delivers a fully-constructed event object verbatim (no `at` defaulting)", () => {
    // emitEvent is the lower-level API that the poller uses when it has
    // already composed a full event (including `at`). This test guards
    // against a refactor that accidentally re-stamps `at`.
    const received: SyncEvent[] = [];
    cleanups.push(syncEvents.onEvent((e) => received.push(e)));

    const payload: SyncEvent = {
      type: "recording_downloaded",
      at: 42,
      recordingId: "xyz",
    };
    syncEvents.emitEvent(payload);

    expect(received[0]).toEqual(payload);
  });
});
