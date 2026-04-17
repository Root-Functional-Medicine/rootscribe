import { useState, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

interface CategoryEditorProps {
  recordingId: string;
  category: string | null;
}

// Inline editable category. Click the displayed value to edit; blur or Enter
// commits; Escape cancels. Keeps the detail sidebar compact instead of an
// always-visible input field for a property that is usually set once.
export function CategoryEditor({ recordingId, category }: CategoryEditorProps): JSX.Element {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category ?? "");
  // Escape triggers setEditing(false), which unmounts the focused input and
  // fires blur → commit(). Without this guard, commit() would persist the
  // pre-cancel draft even though the user explicitly discarded the edit.
  const canceledRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(category ?? "");
  }, [category, editing]);

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["recording", recordingId] });
    await qc.invalidateQueries({ queryKey: ["recordings"] });
  };

  const mutation = useMutation({
    mutationFn: (value: string | null) => api.setCategory(recordingId, value),
    onSuccess: invalidate,
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
              commit();
            }
            if (e.key === "Escape") {
              canceledRef.current = true;
              setDraft(category ?? "");
              setEditing(false);
            }
          }}
          placeholder="e.g. client-intake"
        />
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
