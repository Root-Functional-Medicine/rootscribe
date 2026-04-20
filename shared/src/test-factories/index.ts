// Fishery factories for shapes exported from @rootscribe/shared. Consumed by
// web/, server/, and inbox-mcp/ test suites via the `@rootscribe/shared/test-factories`
// subpath export. See the `./test-factories` entry in shared/package.json.
//
// Factories live here (rather than per-package) so shape drift between a
// web-side RecordingDetail literal and a server-side one is impossible —
// both sides consume the same canonical defaults and traits.

export { recordingDetailFactory } from "./recordingDetail.js";
export { recordingRowFactory } from "./recordingRow.js";
export { plaudRawRecordingFactory } from "./plaudRawRecording.js";
export { jiraLinkFactory } from "./jiraLink.js";
export { inboxMutationResponseFactory } from "./inboxMutationResponse.js";
