import { useState, type KeyboardEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

interface TagEditorProps {
  recordingId: string;
  tags: string[];
}

export function TagEditor({ recordingId, tags }: TagEditorProps): JSX.Element {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["recording", recordingId] });
    await qc.invalidateQueries({ queryKey: ["recordings"] });
  };

  const addTag = useMutation({
    mutationFn: (tag: string) => api.addTag(recordingId, tag),
    onSuccess: invalidate,
  });
  const removeTag = useMutation({
    mutationFn: (tag: string) => api.removeTag(recordingId, tag),
    onSuccess: invalidate,
  });

  const commit = (): void => {
    const value = draft.trim();
    if (!value) return;
    if (tags.includes(value)) {
      setDraft("");
      return;
    }
    addTag.mutate(value);
    setDraft("");
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
        />
        <button
          onClick={commit}
          disabled={!draft.trim() || addTag.isPending}
          className="btn-secondary text-sm disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}
