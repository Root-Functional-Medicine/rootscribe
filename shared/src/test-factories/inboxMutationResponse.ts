import { Factory } from "fishery";
import type { InboxMutationResponse } from "../api.js";
import type { RecordingDetail } from "../recording.js";
import { recordingDetailFactory } from "./recordingDetail.js";

// Factory for the /api/inbox/:id mutation response shape. Wraps
// recordingDetailFactory so callers that only care about the recording's
// status can do `.withRecording(recordingDetailFactory.reviewed().build())`
// without rebuilding the whole wrapper shape.

interface InboxMutationResponseTransient {
  recording?: RecordingDetail;
}

class InboxMutationResponseFactory extends Factory<
  InboxMutationResponse,
  InboxMutationResponseTransient
> {
  withRecording(recording: RecordingDetail): this {
    return this.transient({ recording }) as this;
  }

  withAvailableTags(...availableTags: string[]): this {
    return this.params({ availableTags }) as this;
  }

  withAvailableCategories(...availableCategories: string[]): this {
    return this.params({ availableCategories }) as this;
  }
}

export const inboxMutationResponseFactory =
  InboxMutationResponseFactory.define(({ transientParams }) => ({
    recording: transientParams.recording ?? recordingDetailFactory.build(),
    availableTags: [],
    availableCategories: [],
  }));
