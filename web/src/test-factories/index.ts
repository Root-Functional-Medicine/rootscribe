// Web-package Fishery factories. Shapes that originate in @rootscribe/shared
// (RecordingDetail, JiraLink, InboxMutationResponse) live in the shared package
// under `@rootscribe/shared/test-factories` — import those directly when you
// need them. This module covers web-only shapes: API responses composed in the
// server-web boundary, component props, and the UI's AppConfig view.

export { appConfigFactory } from "./appConfig.js";
export { syncStatusResponseFactory } from "./syncStatusResponse.js";
export { recordingsListResponseFactory } from "./recordingsListResponse.js";
export { recordingDetailResponseFactory } from "./recordingDetailResponse.js";
export {
  inboxFiltersPropsFactory,
  type InboxFiltersProps,
} from "./inboxFiltersProps.js";
