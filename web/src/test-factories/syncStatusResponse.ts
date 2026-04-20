import { Factory } from "fishery";
import type { SyncStatusResponse } from "@rootscribe/shared";

// Factory for the /api/sync/status response shape. SyncStatusBadge.test.tsx
// previously hand-rolled this literal 8 times with trivial variations on
// `polling`, `authRequired`, and `lastError` — each variant drives a different
// badge render branch. Centralizing them here keeps the badge's branch
// coverage tests readable and makes adding a new variant a one-line trait
// addition rather than another 7-field literal.

class SyncStatusResponseFactory extends Factory<SyncStatusResponse> {
  polling(): this {
    return this.params({ polling: true }) as this;
  }

  authRequired(): this {
    return this.params({ authRequired: true }) as this;
  }

  withError(lastError: string = "sync failed"): this {
    return this.params({ lastError }) as this;
  }

  withLastPoll(lastPollAt: number): this {
    return this.params({ lastPollAt }) as this;
  }

  withPendingTranscripts(pendingTranscripts: number): this {
    return this.params({ pendingTranscripts }) as this;
  }

  withErrorsLast24h(errorsLast24h: number): this {
    return this.params({ errorsLast24h }) as this;
  }
}

export const syncStatusResponseFactory = SyncStatusResponseFactory.define(
  () => ({
    lastPollAt: null,
    nextPollAt: null,
    polling: false,
    pendingTranscripts: 0,
    errorsLast24h: 0,
    lastError: null,
    authRequired: false,
  }),
);
