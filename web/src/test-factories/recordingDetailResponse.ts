import { Factory } from "fishery";
import type {
  RecordingDetail,
  RecordingDetailResponse,
} from "@rootscribe/shared";
import { recordingDetailFactory } from "@rootscribe/shared/test-factories";

// Factory for the /api/recordings/:id detail response shape. Wraps
// recordingDetailFactory so callers chain `.withRecording(
// recordingDetailFactory.reviewed().build())` to vary only the recording's
// status; the rest of the wrapper (mediaBase, facets) keeps its defaults.

interface RecordingDetailResponseTransient {
  recording?: RecordingDetail;
}

class RecordingDetailResponseFactory extends Factory<
  RecordingDetailResponse,
  RecordingDetailResponseTransient
> {
  withRecording(recording: RecordingDetail): this {
    return this.transient({ recording }) as this;
  }

  withMediaBase(mediaBase: string): this {
    return this.params({ mediaBase }) as this;
  }

  withAvailableTags(...availableTags: string[]): this {
    return this.params({ availableTags }) as this;
  }

  withAvailableCategories(...availableCategories: string[]): this {
    return this.params({ availableCategories }) as this;
  }
}

export const recordingDetailResponseFactory =
  RecordingDetailResponseFactory.define(({ transientParams }) => ({
    recording: transientParams.recording ?? recordingDetailFactory.build(),
    mediaBase: "/media/rec-1",
    availableTags: [],
    availableCategories: [],
  }));
