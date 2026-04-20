import { Factory } from "fishery";
import type { SeedRecording } from "../test-seed/fixtures.js";

// Factory for the server-owned SeedRecording shape (distinct from the shared
// RecordingRow — field names differ: startTimeMs vs startTime, etc., reflecting
// the seed module's DB-mapped bindparams).
//
// The `SEED_RECORDINGS` fixture array in test-seed/fixtures.ts intentionally
// uses hand-written values so Playwright E2E assertions can lock on specific
// dates/filenames. This factory is for ad-hoc SeedRecording objects needed
// inside unit tests (e.g. a test that seeds a single extra row), not for
// rewriting the fixture.

class SeedRecordingFactory extends Factory<SeedRecording> {
  reviewed(reviewedAtMs: number = Date.parse("2026-04-15T12:00:00Z")): this {
    return this.params({
      inboxStatus: "reviewed",
      reviewedAtMs,
      snoozedUntilMs: null,
    }) as this;
  }

  archived(): this {
    return this.params({
      inboxStatus: "archived",
      snoozedUntilMs: null,
      reviewedAtMs: null,
    }) as this;
  }

  snoozed(
    snoozedUntilMs: number = Date.parse("2026-04-20T00:00:00Z") + 86_400_000,
  ): this {
    return this.params({
      inboxStatus: "new",
      snoozedUntilMs,
      reviewedAtMs: null,
    }) as this;
  }

  withCategory(category: string): this {
    return this.params({ category }) as this;
  }
}

const BASE_TIME = Date.parse("2026-04-15T12:00:00Z");

export const seedRecordingFactory = SeedRecordingFactory.define(
  ({ sequence }) => ({
    id: `rec-seed-${sequence.toString().padStart(2, "0")}`,
    filename: `seeded recording ${sequence}`,
    startTimeMs: BASE_TIME,
    endTimeMs: BASE_TIME + 300_000,
    durationMs: 300_000,
    filesizeBytes: 4_800_000,
    serialNumber: `SN-SEED-${sequence}`,
    folder: `2026-04-15_seeded_recording_${sequence}__rec-seed`,
    inboxStatus: "new" as const,
    snoozedUntilMs: null,
    category: null,
    reviewedAtMs: null,
  }),
);
