import { Factory } from "fishery";
import type {
  RecordingRow,
  RecordingsListResponse,
} from "@rootscribe/shared";

// Factory for the /api/recordings list response shape. Dashboard.test.tsx
// and Inbox tests both build this wrapper around a `RecordingRow[]`; keeping
// a single factory means totalBytes auto-derives from the items so tests
// don't drift out of sync with their own fixture data.

interface RecordingsListResponseTransient {
  items?: RecordingRow[];
}

class RecordingsListResponseFactory extends Factory<
  RecordingsListResponse,
  RecordingsListResponseTransient
> {
  withItems(...items: RecordingRow[]): this {
    return this.transient({ items }) as this;
  }

  withAvailableTags(...availableTags: string[]): this {
    return this.params({ availableTags }) as this;
  }

  withAvailableCategories(...availableCategories: string[]): this {
    return this.params({ availableCategories }) as this;
  }
}

export const recordingsListResponseFactory =
  RecordingsListResponseFactory.define(({ transientParams }) => {
    const items = transientParams.items ?? [];
    return {
      total: items.length,
      totalBytes: items.reduce((acc, row) => acc + row.filesizeBytes, 0),
      items,
      availableTags: [],
      availableCategories: [],
    };
  });
