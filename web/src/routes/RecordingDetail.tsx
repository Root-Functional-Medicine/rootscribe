import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api } from "../api.js";

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function RecordingDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const audioRef = useRef<HTMLAudioElement>(null);
  const id = params.id ?? "";
  const q = useQuery({
    queryKey: ["recording", id],
    queryFn: () => api.recordingDetail(id),
    enabled: !!id,
  });

  if (q.isLoading) return <p className="text-on-surface-variant">loading…</p>;
  if (q.error || !q.data)
    return (
      <div>
        <p className="text-error">Not found.</p>
        <Link to="/" className="btn-ghost mt-3 inline-flex">
          ← Back
        </Link>
      </div>
    );

  const { recording: r, mediaBase } = q.data;

  const del = async (): Promise<void> => {
    if (!confirm("Delete the local copy of this recording? (Plaud is unaffected.)")) return;
    await api.deleteRecording(r.id);
    await qc.invalidateQueries({ queryKey: ["recordings"] });
    navigate("/");
  };

  const skipBack = (): void => {
    if (audioRef.current) audioRef.current.currentTime -= 10;
  };
  const skipForward = (): void => {
    if (audioRef.current) audioRef.current.currentTime += 30;
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <Link to="/" className="text-sm text-on-surface-variant hover:text-on-surface transition-colors">
            ← Recordings
          </Link>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-on-surface">
            {r.filename}
          </h1>
          <div className="mt-1 text-sm text-on-surface-variant font-label">
            {formatDate(r.startTime)} · {formatDuration(r.durationMs)} ·{" "}
            {(r.filesizeBytes / 1024 / 1024).toFixed(1)} MB
          </div>
        </div>
        <button className="btn-secondary text-error border-error/20 hover:border-error/50" onClick={() => void del()}>
          Delete local copy
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {r.audioDownloadedAt && (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-on-surface-variant font-label">
                Audio
              </h2>
              <audio
                ref={audioRef}
                src={`${mediaBase}/audio.ogg`}
                controls
                className="w-full"
                preload="metadata"
              />
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={skipBack}
                  className="btn-ghost text-xs gap-1"
                  title="Skip back 10 seconds"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 17l-5-5 5-5" />
                    <path d="M18 17l-5-5 5-5" />
                  </svg>
                  10s
                </button>
                <button
                  onClick={skipForward}
                  className="btn-ghost text-xs gap-1"
                  title="Skip forward 30 seconds"
                >
                  30s
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 17l5-5-5-5" />
                    <path d="M6 17l5-5-5-5" />
                  </svg>
                </button>
                <a
                  href={`${mediaBase}/audio.ogg`}
                  className="btn-ghost text-xs ml-auto"
                  download
                >
                  Download .ogg
                </a>
              </div>
            </div>
          )}

          {r.transcriptText ? (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-on-surface-variant font-label">
                Transcript
              </h2>
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-on-surface">
                {r.transcriptText}
              </pre>
            </div>
          ) : r.audioDownloadedAt ? (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-on-surface-variant font-label">
                Transcript
              </h2>
              <p className="text-sm text-on-surface-variant">
                Transcript is still pending on Plaud's side. We'll pull it on the next
                sync cycle.
              </p>
            </div>
          ) : null}
        </div>

        <aside className="space-y-6">
          {r.summaryMarkdown && (
            <div className="card p-5">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-on-surface-variant font-label">
                Summary
              </h2>
              <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-on-surface">
                {r.summaryMarkdown}
              </div>
            </div>
          )}
          <div className="card p-5 text-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-on-surface-variant font-label">
              Details
            </h2>
            <dl className="space-y-2">
              <Meta label="Recording ID" value={r.id} mono />
              <Meta label="Device" value={r.serialNumber} mono />
              <Meta label="Folder" value={r.folder} mono />
              <Meta
                label="Downloaded"
                value={r.audioDownloadedAt ? formatDate(r.audioDownloadedAt) : "pending"}
              />
              <Meta
                label="Transcript downloaded"
                value={
                  r.transcriptDownloadedAt
                    ? formatDate(r.transcriptDownloadedAt)
                    : "pending"
                }
              />
              {r.lastError && <Meta label="Last error" value={r.lastError} />}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Meta({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-on-surface-variant font-label">{label}</dt>
      <dd className={`mt-0.5 break-all text-on-surface ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
