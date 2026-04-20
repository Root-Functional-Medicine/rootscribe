import { Factory } from "fishery";
import type { SeedRecording } from "../helpers/schema.js";

// Factory for the inbox-mcp-local SeedRecording shape consumed by
// `seedRecording(dbFile, ...)` in tests/helpers/schema.ts. The existing helper
// accepts SPARSE input (only required fields) and fills defaults via `pick()`,
// which effectively makes it factory-shaped already — most call sites in
// db.test.ts pass 3-4 fields and are more readable without a Fishery wrapper.
//
// This factory exists for the future case where a test needs a fully-hydrated
// SeedRecording with specific traits applied (e.g. "reviewed + snoozed +
// categorized") without hand-spreading the combined overrides. New tests
// should prefer the factory; pre-existing 3-4-field call sites can stay as
// they are — see the DEVX-104 PR description for the inbox-mcp exemption.
//
// Lives under tests/factories/ (not src/test-factories/ like the web and
// server packages) because the `SeedRecording` type itself is test-only —
// defined in tests/helpers/schema.ts. Pulling it into src/ to satisfy the
// TypeScript rootDir constraint would leak a test concept into the
// production module graph.

class SeedRecordingFactory extends Factory<SeedRecording> {
  reviewed(): this {
    return this.params({ inbox_status: "reviewed" }) as this;
  }

  archived(): this {
    return this.params({ inbox_status: "archived" }) as this;
  }

  snoozed(
    snoozed_until: number = Date.parse("2026-04-20T00:00:00Z") + 86_400_000,
  ): this {
    return this.params({
      inbox_status: "new" as const,
      snoozed_until,
    }) as this;
  }

  withoutTranscript(): this {
    return this.params({
      transcript_downloaded_at: null,
      transcript_text: null,
    }) as this;
  }

  withCategory(category: string): this {
    return this.params({ category }) as this;
  }

  withTranscriptText(transcript_text: string): this {
    return this.params({ transcript_text }) as this;
  }
}

export const inboxSeedRecordingFactory = SeedRecordingFactory.define(
  ({ sequence }) => ({
    id: `rec-seed-${sequence}`,
    filename: `seed recording ${sequence}`,
    folder: `folder-${sequence}`,
    start_time: Date.parse("2026-04-15T12:00:00Z"),
    duration_ms: 60_000,
    transcript_path: null,
    summary_path: null,
    transcript_downloaded_at: Date.parse("2026-04-15T12:30:00Z"),
    transcript_text: null,
    inbox_status: "new" as const,
    category: null,
    snoozed_until: null,
    channel_notified_at: null,
  }),
);
