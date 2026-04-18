import { useId, useState, useEffect, useRef, type JSX } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InboxMutationResponse } from "@rootscribe/shared";
import { api } from "../api.js";
import { applyRecordingMutation } from "../lib/recordingCache.js";

interface CategoryEditorProps {
  recordingId: string;
  category: string | null;
  // Corpus of every category in use across all recordings. Offered as datalist
  // suggestions so the user picks from the existing taxonomy rather than
  // inventing variants (e.g. `client-intake` vs `client_intake`).
  availableCategories: string[];
}

// Inline editable category. Click the displayed value to edit; blur or Enter
// commits; Escape cancels. Keeps the detail sidebar compact instead of an
// always-visible input field for a property that is usually set once.
export function CategoryEditor({
  recordingId,
  category,
  availableCategories,
}: CategoryEditorProps): JSX.Element {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category ?? "");
  // Escape triggers setEditing(false), which unmounts the focused input and
  // fires blur → commit(). Without this guard, commit() would persist the
  // pre-cancel draft even though the user explicitly discarded the edit.
  const canceledRef = useRef(false);
  // Stable id for associating the datalist with the input even if multiple
  // CategoryEditors share a page.
  const listId = useId();

  useEffect(() => {
    if (!editing) setDraft(category ?? "");
  }, [category, editing]);

  const mutation = useMutation({
    mutationFn: (value: string | null) => api.setCategory(recordingId, value),
    onSuccess: (response: InboxMutationResponse) =>
      applyRecordingMutation(qc, recordingId, response),
  });

  const commit = (): void => {
    if (canceledRef.current) {
      canceledRef.current = false;
      setEditing(false);
      return;
    }
    const trimmed = draft.trim();
    const next = trimmed || null;
    if (next !== category) mutation.mutate(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex gap-1.5">
        <input
          className="input text-sm py-1.5"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // Let onBlur be the single commit path — calling commit()
              // here and then setEditing(false) would fire a second commit
              // on the resulting blur, sending a duplicate PATCH.
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              canceledRef.current = true;
              setDraft(category ?? "");
              setEditing(false);
            }
          }}
          placeholder="e.g. client-intake"
          list={listId}
        />
        <datalist id={listId}>
          {availableCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {category ? (
        <button
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 rounded-full bg-secondary/10 text-secondary text-xs font-medium px-2.5 py-0.5 hover:bg-secondary/20 transition-colors"
        >
          {category}
        </button>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-on-surface-variant italic hover:text-on-surface transition-colors"
        >
          Add category…
        </button>
      )}
      {category && (
        <button
          onClick={() => mutation.mutate(null)}
          disabled={mutation.isPending}
          className="text-[10px] uppercase tracking-wider text-on-surface-variant hover:text-error transition-colors"
          title="Clear category"
        >
          clear
        </button>
      )}
    </div>
  );
}
