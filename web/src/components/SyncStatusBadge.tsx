import { useEffect, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function SyncStatusBadge(): JSX.Element {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["sync-status"],
    queryFn: api.syncStatus,
    refetchInterval: 10_000,
  });
  const [, force] = useState(0);
  // Re-render every 5s so the "xx ago" string stays fresh.
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  // Listen to sync events over SSE to update immediately.
  useEffect(() => {
    const es = new EventSource("/api/sync/events");
    es.onmessage = () => {
      qc.invalidateQueries({ queryKey: ["sync-status"] });
      qc.invalidateQueries({ queryKey: ["recordings"] });
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [qc]);

  const s = status.data;
  if (!s) return <span className="pill bg-surface-container text-on-surface-variant">loading</span>;
  if (s.authRequired) {
    return <span className="pill bg-error/15 text-error">auth required</span>;
  }
  if (s.polling) {
    return (
      <span className="pill border border-primary/40 bg-primary/15 text-primary">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        syncing
      </span>
    );
  }
  if (s.lastError) {
    return <span className="pill bg-error/15 text-error">error</span>;
  }
  return (
    <span className="pill border border-outline-variant/40 bg-surface-container-low text-on-surface-variant">
      synced {formatRelative(s.lastPollAt)}
    </span>
  );
}
