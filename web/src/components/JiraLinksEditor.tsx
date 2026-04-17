import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JiraLink, RecordingDetail } from "@applaud/shared";
import { isValidJiraKey, buildJiraUrl } from "@applaud/shared";
import { api } from "../api.js";
import { applyRecordingMutation } from "../lib/recordingCache.js";

interface JiraLinksEditorProps {
  recordingId: string;
  links: JiraLink[];
}

export function JiraLinksEditor({ recordingId, links }: JiraLinksEditorProps): JSX.Element {
  const qc = useQueryClient();
  const [issueKey, setIssueKey] = useState("");
  const [issueUrl, setIssueUrl] = useState("");

  // Read the configured base URL so we can auto-construct a full link when the
  // user only pastes an issue key. Config is already cached by react-query and
  // shared with Settings/SetupWizard, so this is a cheap read.
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config });
  const jiraBaseUrl = cfg.data?.config.jiraBaseUrl ?? "";

  const applyResponse = (response: { recording: RecordingDetail }): void =>
    applyRecordingMutation(qc, recordingId, response);

  const addLink = useMutation({
    mutationFn: (params: { issueKey: string; issueUrl: string | null }) =>
      api.addJiraLink(recordingId, params),
    onSuccess: applyResponse,
  });
  const removeLink = useMutation({
    mutationFn: (key: string) => api.removeJiraLink(recordingId, key),
    onSuccess: applyResponse,
  });

  const normalized = issueKey.trim().toUpperCase();
  const keyValid = isValidJiraKey(normalized);

  // If the user didn't provide an explicit URL, fall back to the configured
  // base. This is the common case — paste a key, hit Enter, get a proper link.
  const resolvedUrl = (): string | null => {
    const explicit = issueUrl.trim();
    if (explicit) return explicit;
    if (keyValid && jiraBaseUrl) return buildJiraUrl(jiraBaseUrl, normalized);
    return null;
  };

  const commit = (): void => {
    if (!keyValid) return;
    if (links.some((l) => l.issueKey === normalized)) {
      setIssueKey("");
      setIssueUrl("");
      return;
    }
    addLink.mutate({
      issueKey: normalized,
      issueUrl: resolvedUrl(),
    });
    setIssueKey("");
    setIssueUrl("");
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1.5 min-h-[1.5rem]">
        {links.length === 0 && (
          <span className="text-xs text-on-surface-variant italic">No linked issues</span>
        )}
        {links.map((l) => (
          <div
            key={l.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-surface-container-highest px-2.5 py-1.5 text-xs"
          >
            {l.issueUrl ? (
              <a
                href={l.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-primary hover:underline font-mono font-semibold"
              >
                {l.issueKey}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            ) : (
              <span className="font-mono font-semibold text-on-surface">{l.issueKey}</span>
            )}
            <button
              onClick={() => removeLink.mutate(l.issueKey)}
              disabled={removeLink.isPending}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-on-surface-variant hover:bg-error/10 hover:text-error transition-colors"
              title={`Unlink ${l.issueKey}`}
              aria-label={`Unlink ${l.issueKey}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <input
          className="input text-sm py-1.5 font-mono"
          placeholder="ISSUE-123"
          value={issueKey}
          onChange={(e) => setIssueKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <input
          className="input text-xs py-1.5"
          placeholder={
            jiraBaseUrl
              ? `Auto: ${buildJiraUrl(jiraBaseUrl, normalized || "KEY")}`
              : "https://… (optional)"
          }
          value={issueUrl}
          onChange={(e) => setIssueUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button
          onClick={commit}
          disabled={!keyValid || addLink.isPending}
          className="btn-secondary text-sm w-full disabled:opacity-50"
        >
          {keyValid ? "Link issue" : issueKey ? "Invalid key (e.g. DEVX-96)" : "Link issue"}
        </button>
      </div>
    </div>
  );
}
