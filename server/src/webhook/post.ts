import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WebhookPayload, WebhookEvent, RecordingRow } from "@rootscribe/shared";
import { ensureInstanceId, loadConfig } from "../config.js";
import { getDb } from "../db.js";
import { logger } from "../logger.js";

import { encodeFolderPath } from "../lib/url.js";
import { signWebhook } from "./sign.js";

const BACKOFF_MS = [5_000, 30_000, 120_000];

// Advertised on every outbound delivery. Kept in lockstep with package.json
// by the release checklist (see CHANGELOG); deriving it at build time is a
// DEVX-314 follow-up.
const USER_AGENT = "rootscribe/0.2.0";

// Latches so each warning is logged once per process, not once per
// delivery — a long-running install would otherwise spam the log on every
// poll cycle.
let warnedUnsigned = false;
let warnedInvalidSecret = false;

// loadConfig() trusts settings.json's shape, so a hand-edited
// `"secret": 12345` (or an object) would reach createHmac(), throw inside
// fireRaw's try, and retry the same broken delivery forever. Only a
// non-empty string is a usable key; anything else is treated as "no secret"
// with a one-time warning.
function usableSecret(secret: unknown): string | undefined {
  if (typeof secret === "string") return secret || undefined;
  if (secret != null && !warnedInvalidSecret) {
    warnedInvalidSecret = true;
    logger.warn(
      { type: typeof secret },
      "persisted webhook secret is not a string — sending deliveries unsigned until it is fixed in Settings",
    );
  }
  return undefined;
}

/**
 * Headers for one outbound delivery attempt.
 *
 * - `x-rootscribe-instance` is always present so a shared receiver can tell
 *   installs apart.
 * - When a webhook secret is configured, `x-rootscribe-timestamp` and
 *   `x-rootscribe-signature: t=<sec>,v1=<hex>` are added. The signature
 *   covers the exact `body` string passed to fetch, and the timestamp is
 *   computed per attempt so a retry after backoff still lands inside the
 *   receiver's tolerance window.
 * - Without a secret, the first delivery logs a one-time warning so the
 *   operator knows receivers cannot verify origin.
 *
 * `secret` is the key to sign with — the persisted one for real deliveries,
 * or a caller-supplied draft for test sends (so Settings can verify a value
 * the user has typed but not yet saved). Empty/undefined/non-string means
 * unsigned. `instanceId` likewise overrides the persisted instance id for
 * test sends only; real deliveries always use ensureInstanceId().
 */
function deliveryHeaders(
  event: WebhookEvent,
  body: string,
  rawSecret: unknown,
  instanceId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-rootscribe-event": event,
    "x-rootscribe-instance": instanceId || ensureInstanceId(),
  };
  const secret = usableSecret(rawSecret);
  if (secret) {
    const timestampSec = Math.floor(Date.now() / 1000);
    headers["x-rootscribe-timestamp"] = String(timestampSec);
    headers["x-rootscribe-signature"] = `t=${timestampSec},v1=${signWebhook(secret, timestampSec, body)}`;
  } else if (!warnedUnsigned) {
    warnedUnsigned = true;
    logger.warn(
      "webhook deliveries are unsigned — set a webhook secret in Settings so receivers can verify origin",
    );
  }
  return headers;
}

function readIfExists(absPath: string): string | null {
  try {
    if (!existsSync(absPath)) return null;
    return readFileSync(absPath, "utf8");
  } catch (err) {
    logger.warn({ err, absPath }, "failed to read file for webhook inline content");
    return null;
  }
}

function buildPayload(event: WebhookEvent, row: RecordingRow): WebhookPayload {
  const cfg = loadConfig();
  const host = cfg.bind.host === "0.0.0.0" ? "127.0.0.1" : cfg.bind.host;
  const base = `http://${host}:${cfg.bind.port}/media/${encodeFolderPath(row.folder)}`;
  const payload: WebhookPayload = {
    event,
    recording: {
      id: row.id,
      filename: row.filename,
      start_time_ms: row.startTime,
      end_time_ms: row.endTime,
      duration_ms: row.durationMs,
      filesize_bytes: row.filesizeBytes,
      serial_number: row.serialNumber,
    },
    files: {
      folder: row.folder,
      audio: `${row.folder}/audio.ogg`,
      transcript: `${row.folder}/transcript.json`,
      summary: `${row.folder}/summary.md`,
    },
    http_urls: {
      audio: `${base}/audio.ogg`,
      transcript: `${base}/transcript.json`,
      summary: `${base}/summary.md`,
    },
  };

  if (event === "transcript_ready" && cfg.recordingsDir) {
    const folderAbs = path.join(cfg.recordingsDir, row.folder);
    payload.content = {
      transcript_text: readIfExists(path.join(folderAbs, "transcript.txt")),
      summary_markdown: readIfExists(path.join(folderAbs, "summary.md")),
    };
  }

  return payload;
}

function logAttempt(
  recordingId: string | null,
  event: WebhookEvent,
  url: string,
  statusCode: number | null,
  snippet: string | null,
  durationMs: number,
  error: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO webhook_log (recording_id, event, url, status_code, response_snippet, fired_at, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(recordingId, event, url, statusCode, snippet, Date.now(), durationMs, error);
}

export async function fireWebhookForRecording(
  event: WebhookEvent,
  row: RecordingRow,
): Promise<boolean> {
  const cfg = loadConfig();
  // loadConfig() only type-asserts settings.json, so `enabled` can hold any
  // shape. Test it as `!== true` rather than for falsiness: a hand-edited
  // `"enabled": "false"` is a truthy string and would otherwise fire the very
  // deliveries the user meant to disable. redactForClient() in
  // routes/config.ts applies the identical `=== true` rule so the UI and this
  // gate agree on every stored shape.
  if (!cfg.webhook || cfg.webhook.enabled !== true || !cfg.webhook.url) return false;
  const payload = buildPayload(event, row);
  return fireRaw(cfg.webhook.url, payload, row.id, event);
}

async function fireRaw(
  url: string,
  payload: WebhookPayload,
  recordingId: string | null,
  event: WebhookEvent,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  // Capture the signing key AND the instance id ONCE per delivery. A secret
  // rotated in Settings during the 5s/30s backoff must not re-sign the
  // retry with the new key — the receiver still expects the old one and a
  // transient 503 would turn into a permanent rejection. Likewise an
  // instance id changed mid-backoff must not re-stamp the retry: it is the
  // SAME logical delivery, and a receiver keying dedup or attribution on
  // (instance, event) would otherwise see the retry as a second install.
  // The timestamp/signature are still recomputed per attempt inside
  // deliveryHeaders().
  const secret = loadConfig().webhook?.secret;
  const instanceId = ensureInstanceId();
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: deliveryHeaders(event, body, secret, instanceId),
        body,
      });
      const text = (await res.text().catch(() => "")).slice(0, 500);
      const ok = res.status >= 200 && res.status < 300;
      logAttempt(recordingId, event, url, res.status, text, Date.now() - started, ok ? null : `HTTP ${res.status}`);
      if (ok) return true;
      if (attempt < BACKOFF_MS.length - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      return false;
    } catch (err) {
      logAttempt(
        recordingId,
        event,
        url,
        null,
        null,
        Date.now() - started,
        err instanceof Error ? err.message : String(err),
      );
      if (attempt < BACKOFF_MS.length - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      logger.warn({ err, url }, "webhook fired up all retries");
      return false;
    }
  }
  return false;
}

function buildTestPayload(): WebhookPayload & { test: true } {
  const cfg = loadConfig();
  const host = cfg.bind.host === "0.0.0.0" ? "127.0.0.1" : cfg.bind.host;
  const folder = "2026/04/11/sample-recording";
  const base = `http://${host}:${cfg.bind.port}/media/${encodeFolderPath(folder)}`;
  const now = Date.now();
  return {
    test: true,
    event: "transcript_ready",
    recording: {
      id: "sample-recording-id",
      filename: "sample.ogg",
      start_time_ms: now - 60_000,
      end_time_ms: now,
      duration_ms: 60_000,
      filesize_bytes: 123456,
      serial_number: "SAMPLE1234",
    },
    files: {
      folder,
      audio: `${folder}/audio.ogg`,
      transcript: `${folder}/transcript.json`,
      summary: `${folder}/summary.md`,
    },
    http_urls: {
      audio: `${base}/audio.ogg`,
      transcript: `${base}/transcript.json`,
      summary: `${base}/summary.md`,
    },
    content: {
      transcript_text: "This is a sample transcript from a RootScribe test webhook.",
      summary_markdown: "# Sample Summary\n\nThis is a sample summary from a RootScribe test webhook.",
    },
  };
}

/**
 * Test a webhook URL without retries, for UI validation.
 *
 * `secret` overrides the persisted signing secret so the UI can exercise a
 * draft value before it is saved: undefined = sign with whatever is stored,
 * "" = send unsigned, non-empty = sign with that value. `instanceId` does
 * the same for the `x-rootscribe-instance` header (undefined/"" = the
 * persisted id), so a passing Test describes exactly the headers Save
 * will produce. The route validates it as header-safe before it gets here.
 */
export async function testWebhook(
  url: string,
  secret?: string,
  instanceId?: string,
): Promise<{ ok: boolean; statusCode?: number; bodySnippet?: string; error?: string; durationMs: number }> {
  const started = Date.now();
  const body = JSON.stringify(buildTestPayload());
  const signingSecret = secret ?? loadConfig().webhook?.secret;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...deliveryHeaders("transcript_ready", body, signingSecret, instanceId),
        "x-rootscribe-test": "1",
      },
      body,
    });
    const text = (await res.text().catch(() => "")).slice(0, 500);
    return {
      ok: res.status >= 200 && res.status < 300,
      statusCode: res.status,
      bodySnippet: text,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
}
