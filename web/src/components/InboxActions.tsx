import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecordingDetail, InboxStatus } from "@applaud/shared";
import { api } from "../api.js";
import { applyRecordingMutation } from "../lib/recordingCache.js";
import { SnoozeMenu } from "./SnoozeMenu.js";

interface InboxActionsProps {
  recording: RecordingDetail;
}

// Renders inline action buttons for inbox status transitions. The button
// relevant to the current state is highlighted as primary; the rest are
// secondary. This matches Material You's "active action" pattern without
// needing a dropdown or split button.
export function InboxActions({ recording }: InboxActionsProps): JSX.Element {
  const qc = useQueryClient();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const snoozeToggleRef = useRef<HTMLButtonElement>(null);

  const applyResponse = (response: { recording: RecordingDetail }): void =>
    applyRecordingMutation(qc, recording.id, response);

  const setStatus = useMutation({
    mutationFn: (status: InboxStatus) => api.setInboxStatus(recording.id, status),
    onSuccess: applyResponse,
  });
  const setSnooze = useMutation({
    mutationFn: (until: number | null) => api.setSnooze(recording.id, until),
    onSuccess: applyResponse,
  });

  const busy = setStatus.isPending || setSnooze.isPending;
  const effStatus = recording.effectiveInboxStatus;
  const isSnoozed = effStatus === "snoozed";

  // Snooze popover only makes sense on recordings in the "new" effective state.
  // Auto-close it when the recording transitions away (via Mark Reviewed /
  // Archive / etc.) so a stale-open menu doesn't flash back when the user
  // reopens the item.
  useEffect(() => {
    if (effStatus !== "new" && snoozeOpen) setSnoozeOpen(false);
  }, [effStatus, snoozeOpen]);
  // Prefer the most recent error. /snooze can return 409 if another client
  // moved the recording out of 'new' between render and click, so surfacing
  // the reason keeps the user from silently losing an action.
  const activeError = setSnooze.error ?? setStatus.error;

  return (
    <div className="flex flex-wrap items-start gap-2 relative">
      {/* Mark Reviewed — primary when there's work to do (new/snoozed) */}
      <button
        onClick={() => setStatus.mutate("reviewed")}
        disabled={busy || effStatus === "reviewed"}
        className={`${effStatus === "new" || effStatus === "snoozed" ? "btn-primary" : "btn-secondary"} text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <span className="inline-flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {effStatus === "reviewed" ? "Reviewed" : "Mark Reviewed"}
        </span>
      </button>

      {/* Snooze / Unsnooze */}
      {isSnoozed ? (
        <button
          onClick={() => setSnooze.mutate(null)}
          disabled={busy}
          className="btn-secondary text-sm disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Unsnooze
          </span>
        </button>
      ) : effStatus === "new" ? (
        <div className="relative">
          <button
            ref={snoozeToggleRef}
            onClick={() => setSnoozeOpen((v) => !v)}
            disabled={busy}
            className="btn-secondary text-sm disabled:opacity-50"
          >
            <span className="inline-flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Snooze
            </span>
          </button>
          {snoozeOpen && (
            <SnoozeMenu
              anchorRef={snoozeToggleRef}
              onSelect={(until) => setSnooze.mutate(until)}
              onClose={() => setSnoozeOpen(false)}
            />
          )}
        </div>
      ) : null}

      {/* Archive — hide when already archived */}
      {effStatus !== "archived" && (
        <button
          onClick={() => setStatus.mutate("archived")}
          disabled={busy}
          className="btn-ghost text-sm disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-1.5 text-on-surface-variant">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="21 8 21 21 3 21 3 8" />
              <rect x="1" y="3" width="22" height="5" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
            Archive
          </span>
        </button>
      )}

      {/* Reopen — allow reviewed/archived items back into inbox */}
      {(effStatus === "reviewed" || effStatus === "archived") && (
        <button
          onClick={() => setStatus.mutate("new")}
          disabled={busy}
          className="btn-ghost text-sm disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-1.5 text-on-surface-variant">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            Reopen
          </span>
        </button>
      )}

      {activeError && (
        <p className="basis-full text-xs text-error">
          {activeError instanceof Error ? activeError.message : "Something went wrong."}
        </p>
      )}
    </div>
  );
}
