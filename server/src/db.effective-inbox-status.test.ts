import { describe, expect, it } from "vitest";
import { effectiveInboxStatus } from "./db.js";

describe("effectiveInboxStatus", () => {
  it("returns the raw inbox_status when snoozed_until is null", () => {
    expect(
      effectiveInboxStatus({ inbox_status: "new", snoozed_until: null }),
    ).toBe("new");
    expect(
      effectiveInboxStatus({ inbox_status: "reviewed", snoozed_until: null }),
    ).toBe("reviewed");
    expect(
      effectiveInboxStatus({ inbox_status: "archived", snoozed_until: null }),
    ).toBe("archived");
  });

  it("returns 'snoozed' only when status is 'new' AND snoozed_until is in the future", () => {
    const now = 1_000_000;
    expect(
      effectiveInboxStatus(
        { inbox_status: "new", snoozed_until: now + 60_000 },
        now,
      ),
    ).toBe("snoozed");
  });

  it("ignores future snoozed_until when status is not 'new'", () => {
    const now = 1_000_000;
    expect(
      effectiveInboxStatus(
        { inbox_status: "reviewed", snoozed_until: now + 60_000 },
        now,
      ),
    ).toBe("reviewed");
    expect(
      effectiveInboxStatus(
        { inbox_status: "archived", snoozed_until: now + 60_000 },
        now,
      ),
    ).toBe("archived");
  });

  it("returns 'new' when snoozed_until is in the past (snooze expired)", () => {
    const now = 1_000_000;
    expect(
      effectiveInboxStatus(
        { inbox_status: "new", snoozed_until: now - 1 },
        now,
      ),
    ).toBe("new");
  });

  it("at the exact snooze boundary (snoozed_until === now), snooze is already expired", () => {
    const now = 1_000_000;
    // The implementation uses strict > comparison, so equal means expired.
    expect(
      effectiveInboxStatus(
        { inbox_status: "new", snoozed_until: now },
        now,
      ),
    ).toBe("new");
  });

  it("defaults `now` to Date.now() when omitted", () => {
    // A snooze expiring 1 hour ago must report as 'new' without explicit now.
    const hourAgo = Date.now() - 60 * 60 * 1000;
    expect(
      effectiveInboxStatus({ inbox_status: "new", snoozed_until: hourAgo }),
    ).toBe("new");
  });
});
