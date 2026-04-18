import { useState, useEffect, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InboxMutationResponse } from "@rootscribe/shared";
import { api } from "../api.js";
import { applyRecordingMutation } from "../lib/recordingCache.js";

interface InboxNotesEditorProps {
  recordingId: string;
  notes: string | null;
}

// Textarea that saves on blur. Keeps notes lightweight — the user types and
// clicks away, no Save button needed.
export function InboxNotesEditor({ recordingId, notes }: InboxNotesEditorProps): JSX.Element {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(notes ?? "");

  // Sync when a different recording loads or another client updates this one.
  useEffect(() => {
    setDraft(notes ?? "");
  }, [notes]);

  const mutation = useMutation({
    mutationFn: (value: string | null) => api.setInboxNotes(recordingId, value),
    onSuccess: (response: InboxMutationResponse) =>
      applyRecordingMutation(qc, recordingId, response),
  });

  const commit = (): void => {
    // Serialize updates: ignore blur while a save is in flight so an older
    // response can't overwrite a newer edit when the user types-blurs-types-
    // blurs quickly. The textarea is also disabled during the mutation, so
    // this guard mainly covers programmatic blur races.
    if (mutation.isPending) return;
    // Preserve user-entered whitespace/newlines verbatim — only convert to
    // null when the text is entirely whitespace. Trimming the stored value
    // would silently drop intentional leading/trailing formatting.
    const next = draft.trim() === "" ? null : draft;
    const current = notes ?? null;
    if (next !== current) mutation.mutate(next);
  };

  return (
    <textarea
      className="input text-sm py-2 min-h-[5rem] resize-y font-sans disabled:opacity-60"
      placeholder="Notes…"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      disabled={mutation.isPending}
    />
  );
}
