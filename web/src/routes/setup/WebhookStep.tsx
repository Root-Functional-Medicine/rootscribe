import { useEffect, useRef, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";
import { generateWebhookSecret } from "../../lib/webhookSecret.js";

export function WebhookStep({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}): JSX.Element {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [testing, setTesting] = useState(false);
  // While saving, every draft control and both navigation buttons are
  // disabled: the POST captures the draft at click time and onNext()
  // unmounts the step, so an edit made during the request would be lost.
  const [saving, setSaving] = useState(false);
  // Read-only here: the server minted this on first run. It is editable on
  // the Settings page after setup.
  const cfg = useQuery({ queryKey: ["config"], queryFn: api.config });
  const instanceId = cfg.data?.config.instanceId ?? null;
  // A wizard resumed after a partial setup may already have a stored secret.
  // Next and Test Connection both keep it when this field is blank, so the
  // copy has to say so rather than promise "unsigned".
  const secretConfigured = Boolean(cfg.data?.config.webhook?.secretConfigured);
  // Mirror the stored webhook URL into the draft while the user has not
  // typed: a stored URL hydrates the field so revisiting offers "Next"
  // (keep) instead of "Skip" (which sends webhook=null and would delete the
  // stored URL + secret); and a fresh load that reports NO webhook clears a
  // stale cached value so Next cannot post it back and resurrect a webhook
  // the server just removed. Never clobber a value the user has typed.
  const urlTouched = useRef(false);
  useEffect(() => {
    if (!cfg.data || urlTouched.current) return;
    setUrl(cfg.data.config.webhook?.url ?? "");
  }, [cfg.data]);
  // Any config refresh invalidates the Test Connection — the moment it
  // STARTS (a test already in flight would otherwise land a result against
  // state being replaced, and a refetch that then errors never moves
  // `dataUpdatedAt`) and again when data lands. A refetch may reflect a
  // change another client made, including a secret rotation invisible in
  // the redacted response.
  useEffect(() => {
    if (cfg.isFetching || cfg.dataUpdatedAt) invalidateTest();
  }, [cfg.isFetching, cfg.dataUpdatedAt]);
  // The config query failed and the user has not touched the URL: the
  // field may show stale cached data. Saving that URL together with a typed
  // secret could resurrect a webhook the server removed or changed, so the
  // save is blocked until the user re-enters the URL themselves.
  const staleUrlRisk = cfg.isError && !urlTouched.current;
  const saveBlocked = staleUrlRisk && secret.trim() !== "";
  const [testResult, setTestResult] = useState<null | {
    ok: boolean;
    statusCode?: number;
    bodySnippet?: string;
    error?: string;
  }>(null);
  // See Settings: a Test Connection response is only applied if no draft
  // edit happened while it was in flight.
  const testGeneration = useRef(0);
  const invalidateTest = (): void => {
    testGeneration.current += 1;
    setTestResult(null);
  };

  const test = async (): Promise<void> => {
    // Trim to match the Test Connection button gate (which uses url.trim())
    // and saveAndContinue(). Without this, a URL with surrounding whitespace
    // would hit the button gate but fail server-side Zod validation with a
    // confusing "invalid URL" for what looks like a valid URL in the input.
    const trimmed = url.trim();
    if (!trimmed) return;
    setTesting(true);
    invalidateTest();
    const generation = testGeneration.current;
    try {
      // Sign the test with the draft secret so the receiver verifies the
      // value the user is about to save; blank = let the server use whatever
      // is stored (nothing, on a fresh install).
      const trimmedSecret = secret.trim();
      const r = await api.testWebhook(trimmed, trimmedSecret || undefined);
      if (generation === testGeneration.current) setTestResult(r);
    } catch (err) {
      if (generation === testGeneration.current) {
        setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setTesting(false);
    }
  };

  const saveAndContinue = async (): Promise<void> => {
    // Stored state is unknown (query failed) and the user changed nothing:
    // a hydrated URL may be stale cached data, so re-posting it could
    // resurrect a webhook the server has since removed. Nothing to save.
    if (cfg.isError && !urlTouched.current && secret.trim() === "") {
      onNext();
      return;
    }
    setSaving(true);
    try {
      await persistDraft();
    } finally {
      setSaving(false);
    }
    onNext();
  };

  const persistDraft = async (): Promise<void> => {
    if (url.trim() === "") {
      // A blank URL means "no webhook" only when we KNOW that is the stored
      // state (config loaded) or the user deliberately cleared it. If the
      // config query failed we cannot tell whether a webhook + secret is
      // stored, so leave it untouched rather than post webhook=null.
      if (cfg.isSuccess || urlTouched.current) {
        await api.updateConfig({ webhook: null });
      }
    } else {
      const trimmedSecret = secret.trim();
      await api.updateConfig({
        webhook: {
          url: url.trim(),
          // A typed URL is an explicit "turn it on"; a hydrated (untouched)
          // URL keeps the stored flag, so revisiting the step to add a
          // secret cannot start deliveries on a webhook stored disabled.
          // Echoed explicitly because the server defaults an omitted
          // `enabled` to "URL present".
          enabled: urlTouched.current ? true : (cfg.data?.config.webhook?.enabled ?? true),
          ...(trimmedSecret ? { secret: trimmedSecret } : {}),
        },
      });
    }
    // The app keeps ['config'] fresh for 5s. Without this, Next -> Back
    // would remount the step from the stale cache (webhook: null), show
    // Skip, and post null over the webhook we just saved.
    await qc.invalidateQueries({ queryKey: ["config"] });
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <span className="font-label text-primary text-xs font-bold tracking-widest uppercase">Step 4</span>
        <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Webhook Configuration</h1>
        <p className="text-on-surface-variant text-base max-w-md leading-relaxed">
          Provide a URL to receive updates when transcription is complete. We'll send a POST request with the payload.
        </p>
      </div>

      <div className="space-y-4">
        <label className="font-label text-xs text-on-surface-variant uppercase tracking-wider block">Target Endpoint URL</label>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary/60">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <input
            className="w-full bg-surface-container-highest/50 border-0 rounded-lg py-4 pl-12 pr-4 text-on-surface placeholder:text-on-surface-variant/30 focus:ring-2 focus:ring-primary/40 focus:outline-none font-label tracking-wide"
            type="url"
            placeholder="https://api.yourdomain.com/webhooks/rootscribe"
            value={url}
            disabled={saving}
            onChange={(e) => { urlTouched.current = true; setUrl(e.target.value); invalidateTest(); }}
          />
        </div>

        <label
          htmlFor="wizard-webhook-secret"
          className="font-label text-xs text-on-surface-variant uppercase tracking-wider block pt-2"
        >
          Signing Secret
        </label>
        <div className="flex gap-3">
          <input
            id="wizard-webhook-secret"
            className="w-full bg-surface-container-highest/50 border-0 rounded-lg py-4 px-4 text-on-surface placeholder:text-on-surface-variant/30 focus:ring-2 focus:ring-primary/40 focus:outline-none font-mono text-sm"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              cfg.isError
                ? "could not load current settings — leave blank to keep any stored secret"
                : secretConfigured
                  ? "a secret is already stored — leave blank to keep it, or generate a new one"
                  : "optional — leave blank to send unsigned"
            }
            value={secret}
            disabled={saving}
            onChange={(e) => { setSecret(e.target.value); invalidateTest(); }}
          />
          <button
            type="button"
            className="btn-primary px-6 py-3 whitespace-nowrap"
            disabled={saving}
            onClick={() => { setSecret(generateWebhookSecret()); invalidateTest(); }}
          >
            Generate
          </button>
        </div>
        {saveBlocked && (
          <p className="text-[11px] text-error leading-relaxed">
            Could not load the current settings, so the URL above may be out of date. Re-enter the URL
            to save it together with this secret.
          </p>
        )}
        <p className="text-[11px] text-on-surface-variant leading-relaxed">
          Deliveries are signed with HMAC-SHA256 (<span className="font-mono">x-rootscribe-signature</span>)
          when a secret is set. Paste the same value into your receiver — it is not shown again
          after this step. Test Connection uses the value in this field.
        </p>

        <div className="bg-surface-container-highest/30 p-4 rounded-lg space-y-1">
          <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">Instance ID</p>
          <p className="font-mono text-sm text-primary break-all">
            {instanceId ?? "generated on first run"}
          </p>
          <p className="text-[11px] text-on-surface-variant leading-relaxed">
            Sent as <span className="font-mono">x-rootscribe-instance</span> on every delivery. Editable later in Settings.
          </p>
        </div>

        {/* Info box */}
        <div className="bg-surface-container-highest/30 p-4 rounded-lg flex items-start gap-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-secondary mt-0.5 flex-shrink-0">
            <circle cx="12" cy="12" r="10" opacity="0.2" /><circle cx="12" cy="12" r="4" />
          </svg>
          <div className="space-y-1">
            <p className="text-xs font-medium text-on-surface">Test payload will be sent upon completion.</p>
            <p className="text-[11px] text-on-surface-variant leading-relaxed">Ensure your server is configured to return a 200 OK status to acknowledge receipt.</p>
          </div>
        </div>
      </div>

      {url.trim() && (
        <button
          className="btn-primary px-6 py-3"
          onClick={() => void test()}
          // Requires a successfully loaded, refetch-free config: a blank draft
          // secret is sent as "use the stored one" and the instance header
          // comes from stored state, so a test only means something when
          // that state is known (pending, refetching AND error all disable).
          disabled={testing || saving || !cfg.isSuccess || cfg.isFetching}
        >
          {testing ? "Testing…" : "Test Connection"}
        </button>
      )}

      {testResult && (
        <div className={`rounded-lg p-4 flex items-center gap-3 ${
          testResult.ok ? "bg-secondary/10 border border-secondary/20" : "bg-error/10 border border-error/20"
        }`}>
          {testResult.ok ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-secondary flex-shrink-0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-error flex-shrink-0"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
          )}
          <div>
            <p className={`font-bold text-sm ${testResult.ok ? "text-secondary" : "text-error"}`}>
              {testResult.ok ? "Connection Success" : "Connection Failed"}
            </p>
            <p className={`text-xs ${testResult.ok ? "text-secondary/70" : "text-error/70"}`}>
              {testResult.ok
                ? `HTTP ${testResult.statusCode ?? "?"} OK${testResult.bodySnippet ? ` — ${testResult.bodySnippet.slice(0, 100)}` : ""}`
                : testResult.statusCode ? `HTTP ${testResult.statusCode}` : testResult.error}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-4">
        <button className="flex items-center gap-2 text-on-surface-variant font-semibold text-sm hover:text-on-surface transition-colors group" onClick={onBack} disabled={saving}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          Back
        </button>
        <button
          className="btn-primary px-8 py-3 flex items-center gap-3 shadow-lg shadow-primary/10"
          // Gated until the config query settles AND no refetch is in flight:
          // isPending is false as soon as any data is cached, so a remount
          // with stale cached webhook=null during a refetch would otherwise
          // enable a Skip that posts null over a stored webhook.
          disabled={cfg.isPending || cfg.isFetching || saving || saveBlocked}
          onClick={() => void saveAndContinue()}
        >
          {url.trim() ? "Next" : "Skip"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>
        </button>
      </div>
    </div>
  );
}
