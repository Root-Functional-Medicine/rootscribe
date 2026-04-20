import { Factory } from "fishery";
import type { PlaudRawRecording } from "../recording.js";

// Factory for the upstream Plaud list-endpoint item shape. Used across
// plaud/list, sync/poller, and sync/state tests — each exercises a different
// slice of the `is_trans` / `is_trash` / `is_summary` truth table that drives
// downstream status derivation on the server side.

class PlaudRawRecordingFactory extends Factory<PlaudRawRecording> {
  withTranscript(): this {
    return this.params({
      is_trans: true,
      is_summary: true,
    }) as this;
  }

  withoutTranscript(): this {
    return this.params({
      is_trans: false,
      is_summary: false,
    }) as this;
  }

  trashed(): this {
    return this.params({ is_trash: true }) as this;
  }
}

const BASE_TIME = Date.parse("2026-04-15T12:00:00Z");

export const plaudRawRecordingFactory = PlaudRawRecordingFactory.define(() => ({
  id: "rec-1",
  filename: "recording",
  fullname: "2026-04-15 recording.ogg",
  filesize: 12_345,
  file_md5: "deadbeef",
  start_time: BASE_TIME,
  end_time: BASE_TIME + 60_000,
  duration: 60,
  version: 1,
  version_ms: BASE_TIME,
  edit_time: BASE_TIME + 60_000,
  is_trash: false,
  is_trans: true,
  is_summary: true,
  serial_number: "SN-001",
}));
