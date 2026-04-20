// Server-package Fishery factories. Shapes that originate in @rootscribe/shared
// (RecordingRow, PlaudRawRecording, RecordingDetail, JiraLink) live in the
// shared package under `@rootscribe/shared/test-factories` — import those
// directly when you need them. This module covers server-only shapes:
// upstream Plaud response types and the E2E seed row type.

export { fileDetailDataFactory } from "./fileDetailData.js";
export { seedRecordingFactory } from "./seedRecording.js";
