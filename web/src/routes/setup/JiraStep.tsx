import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";

const DEFAULT_SUGGESTION = "https://rootfunctionalmedicine.atlassian.net/browse/";

export function JiraStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config });
  const [url, setUrl] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed from the existing config value once on first load. Guarded with
  // `initialized` so a React Query refetch (or the user starting to type
  // before the query resolves) doesn't clobber in-flight edits.
  useEffect(() => {
    if (!cfg.data || initialized) return;
    setUrl(cfg.data.config.jiraBaseUrl ?? DEFAULT_SUGGESTION);
    setInitialized(true);
  }, [cfg.data, initialized]);

  const saveAndContinue = async (): Promise<void> => {
    const trimmed = url.trim() || DEFAULT_SUGGESTION;
    setSaveError(null);
    setSaving(true);
    try {
      await api.updateConfig({ jiraBaseUrl: trimmed });
      // Refresh the shared config cache so downstream steps (Review) and other
      // mounted components see the new value immediately instead of briefly
      // showing the stale one.
      await qc.invalidateQueries({ queryKey: ["config"] });
      onNext();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save. Check the URL and try again.");
    } finally {
      setSaving(false);
    }
  };

  const useDefault = (): void => {
    setUrl(DEFAULT_SUGGESTION);
  };

  // Fall back to DEFAULT_SUGGESTION when the input is empty so the preview
  // is always a valid URL — without the fallback, an empty input renders as
  // just "/DEVX-96", which looks broken.
  const preview = (url.trim() || DEFAULT_SUGGESTION).replace(/\/+$/, "") + "/DEVX-96";

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 5</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Jira Integration</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          Paste just an issue key (like <span className="font-mono text-primary">DEVX-96</span>) when
          linking a recording. We'll build the full URL from this base.
        </p>
      </div>

      <div className="space-y-4">
        <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">
          Jira Base URL
        </label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary/60">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <input
            className="w-full bg-surface-container-highest/50 border-0 rounded-lg py-4 pl-12 pr-4 text-on-surface placeholder:text-on-surface-variant/30 focus:ring-2 focus:ring-primary/40 focus:outline-none font-mono text-sm"
            type="url"
            placeholder={DEFAULT_SUGGESTION}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          {url.trim() !== DEFAULT_SUGGESTION && (
            <button
              type="button"
              onClick={useDefault}
              className="text-xs font-label uppercase tracking-widest text-primary hover:underline"
            >
              Use RFM default
            </button>
          )}
          <div className="text-[11px] text-on-surface-variant">
            Example link:{" "}
            <span className="font-mono text-primary break-all">{preview}</span>
          </div>
        </div>

        <div className="bg-surface-container-highest/30 p-4 rounded-lg flex items-start gap-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-secondary mt-0.5 flex-shrink-0">
            <circle cx="12" cy="12" r="10" opacity="0.2" /><circle cx="12" cy="12" r="4" />
          </svg>
          <div className="space-y-1">
            <p className="text-xs font-medium text-on-surface">Later, per-link overrides still work.</p>
            <p className="text-[11px] text-on-surface-variant leading-relaxed">
              On the recording detail page you can paste an explicit URL if a ticket lives on a different instance.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-4">
        <button
          className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group"
          onClick={onBack}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="flex flex-col items-end gap-2">
          {saveError && (
            <p className="text-xs text-error">{saveError}</p>
          )}
          <button
            className="btn-primary px-8 py-3 flex items-center gap-3 shadow-lg shadow-primary/10 disabled:opacity-60"
            onClick={() => void saveAndContinue()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Next"}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
