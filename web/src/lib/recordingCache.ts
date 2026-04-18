import type { QueryClient } from "@tanstack/react-query";
import type { RecordingDetail } from "@applaud/shared";

interface DetailWrapper {
  recording: RecordingDetail;
  mediaBase: string;
  recordingsDir?: string;
}

// Merges a mutation response into the cached `["recording", id]` entry instead
// of triggering a refetch. Preserves:
//   - wrapper fields the mutation response doesn't include (`mediaBase`,
//     `recordingsDir`)
//   - heavy detail fields the server skipped re-reading on mutations
//     (`transcriptText`, `summaryMarkdown`, `metadata`)
//
// Also invalidates the `["recordings"]` list query so dashboard filters and
// counts update accordingly.
export function applyRecordingMutation(
  qc: QueryClient,
  recordingId: string,
  response: { recording: RecordingDetail },
): void {
  qc.setQueryData<DetailWrapper>(["recording", recordingId], (old) => {
    if (!old) {
      // No cached wrapper yet (e.g. mutation fired before detail fetched).
      // Fall back to the response; mediaBase will populate on the next fetch.
      return { recording: response.recording, mediaBase: "" };
    }
    return {
      ...old,
      recording: {
        ...response.recording,
        // Mutations skip file IO; keep cached heavy fields so transcript/
        // summary/metadata don't visibly disappear mid-edit.
        transcriptText: old.recording.transcriptText,
        summaryMarkdown: old.recording.summaryMarkdown,
        metadata: old.recording.metadata,
      },
    };
  });
  void qc.invalidateQueries({ queryKey: ["recordings"] });
}
