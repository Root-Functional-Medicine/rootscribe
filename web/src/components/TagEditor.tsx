import { useId, useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InboxMutationResponse } from "@applaud/shared";
import { api } from "../api.js";
import { applyRecordingMutation } from "../lib/recordingCache.js";

interface TagEditorProps {
  recordingId: string;
  tags: string[];
  // Corpus of every tag used across all recordings. Rendered as a datalist so
  // the browser offers existing tags as suggestions — keeps the user on the
  // established taxonomy instead of creating near-duplicates like
  // `client-intake` vs `client_intake`.
  availableTags: string[];
}

export function TagEditor({ recordingId, tags, availableTags }: TagEditorProps): JSX.Element {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  // Multiple TagEditors can't coexist on one page today, but useId guarantees
  // the <datalist>/<input> pair stays unique even if that changes later.
  const listId = useId();

  const addTag = useMutation({
    mutationFn: (tag: string) => api.addTag(recordingId, tag),
    onSuccess: (response: InboxMutationResponse) => {
      applyRecordingMutation(qc, recordingId, response);
      // Only clear the input after the server confirms — a failed request
      // (network error, server validation) preserves what the user typed so
      // they can retry without retyping.
      setDraft("");
    },
  });
  const removeTag = useMutation({
    mutationFn: (tag: string) => api.removeTag(recordingId, tag),
    onSuccess: (response: InboxMutationResponse) =>
      applyRecordingMutation(qc, recordingId, response),
  });

  const commit = (): void => {
    // Ignore additional submits while a mutation is in flight. The Add button
    // is disabled via `addTag.isPending`, but Enter-in-input bypasses that —
    // without this guard rapid Enter presses queue redundant requests.
    if (addTag.isPending) return;
    const value = draft.trim();
    if (!value) return;
    // Already-present: clear draft immediately — no server call needed.
    if (tags.includes(value)) {
      setDraft("");
      return;
    }
    addTag.mutate(value);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 min-h-[1.5rem]">
        {tags.length === 0 && (
          <span className="text-xs text-on-surface-variant italic">No tags</span>
        )}
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary text-xs font-medium pl-2.5 pr-1 py-0.5"
          >
            {t}
            <button
              onClick={() => removeTag.mutate(t)}
              disabled={removeTag.isPending}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-primary/20 transition-colors"
              title={`Remove ${t}`}
              aria-label={`Remove tag ${t}`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          className="input text-sm py-1.5"
          placeholder="Add tag…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          list={listId}
        />
        <datalist id={listId}>
          {availableTags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <button
          onClick={commit}
          disabled={!draft.trim() || addTag.isPending}
          className="btn-secondary text-sm disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {addTag.isError && (
        <p className="text-xs text-error">
          Couldn't add tag: {addTag.error instanceof Error ? addTag.error.message : "unknown error"}
        </p>
      )}
    </div>
  );
}
