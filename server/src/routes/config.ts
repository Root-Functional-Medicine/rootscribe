import { Router } from "express";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  accessSync,
  constants,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { INSTANCE_ID_PATTERN, type AppConfig } from "@rootscribe/shared";
import { loadConfig, updateConfig } from "../config.js";
import { testWebhook } from "../webhook/post.js";
import { poller } from "../sync/poller.js";

export const configRouter = Router();

// Strip everything a browser must never see. The Plaud token is replaced by
// a sentinel; the webhook signing secret is removed outright and reported as
// a boolean — this API has no auth and Docker binds 0.0.0.0, so a LAN client
// that could read the secret could forge HMAC-valid deliveries.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactForClient(cfg: AppConfig): AppConfig {
  // loadConfig() only type-asserts the file, so `webhook` can be a string or
  // an array from a hand-edited settings.json. Rest-spreading those would
  // leak characters / nested objects (including a `secret`) into the
  // response — anything that is not a plain object is reported as null.
  //
  // Same rule as the delivery path's usableSecret(): only a non-empty STRING
  // signs, so only that counts as "configured" — a hand-edited non-string
  // must not make Settings claim verification is active.
  // Beyond "is an object", the URL must be a string: a hand-edited
  // `{ url: 123 }` would otherwise reach the UI, whose hydration calls
  // url.trim() and throws before the user can repair the config. Anything
  // short of a valid shape is reported as null so Settings/wizard render a
  // clean, saveable state.
  const webhook =
    isPlainObject(cfg.webhook) && typeof cfg.webhook["url"] === "string"
      ? (({ secret: storedSecret, url, enabled }) => ({
          url,
          enabled: Boolean(enabled),
          secretConfigured: typeof storedSecret === "string" && storedSecret.length > 0,
        }))(cfg.webhook as AppConfig["webhook"] & object)
      : null;
  return { ...cfg, token: cfg.token ? "***REDACTED***" : null, webhook };
}

configRouter.get("/", (_req, res) => {
  res.json({ config: redactForClient(loadConfig()) });
});

const PatchSchema = z.object({
  recordingsDir: z.string().min(1).optional(),
  webhook: z
    .object({
      url: z.string().url().or(z.literal("")),
      enabled: z.boolean().optional(),
      secret: z.string().optional(),
    })
    .nullable()
    .optional(),
  pollIntervalMinutes: z.number().int().min(1).max(120).optional(),
  bind: z
    .object({
      host: z.string(),
      port: z.number().int().min(1).max(65535),
    })
    .optional(),
  // Zod strips unknown keys by default, so fields must be listed here to be
  // persisted. Jira base URL: require an http/https URL — `z.string().url()`
  // alone accepts `javascript:` / `data:` etc., and this value is later used
  // to build <a href>s via buildJiraUrl(), so non-web schemes would become an
  // XSS / navigation vector.
  jiraBaseUrl: z
    .string()
    .url()
    .refine((value) => {
      try {
        const proto = new URL(value).protocol;
        return proto === "http:" || proto === "https:";
      } catch {
        return false;
      }
    }, "jiraBaseUrl must use http or https")
    .optional(),
  // Sent verbatim as the `x-rootscribe-instance` header on every outbound
  // webhook — see INSTANCE_ID_PATTERN in @rootscribe/shared for why it is
  // restricted to a header-safe token. The same rule guards the persisted
  // value in ensureInstanceId().
  instanceId: z
    .string()
    .trim()
    .regex(
      INSTANCE_ID_PATTERN,
      "instanceId must be 1-128 characters of letters, digits, '.', '_', ':' and '-'",
    )
    .optional(),
});

configRouter.post("/", (req, res) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const patch = parsed.data;
  // Tri-state secret: omitted keeps whatever is stored (clients can't read
  // it back, so an unrelated save must not wipe it), "" clears, non-empty
  // replaces. Clearing the whole webhook (null) drops the secret with it.
  const storedSecret = loadConfig().webhook?.secret;
  const nextSecret =
    patch.webhook?.secret === undefined ? storedSecret : patch.webhook.secret || undefined;
  // Only touch `webhook` when the patch carries it. Spreading an explicit
  // `webhook: undefined` into updateConfig() would overwrite the stored
  // object — a partial patch (jiraBaseUrl-only, pollIntervalMinutes-only)
  // must leave the URL and secret exactly as they were.
  const { webhook: _patchWebhook, ...rest } = patch;
  const normalized: Partial<AppConfig> = {
    ...rest,
    ...(patch.webhook !== undefined
      ? {
          webhook: patch.webhook
            ? {
                url: patch.webhook.url,
                enabled: patch.webhook.enabled ?? patch.webhook.url.length > 0,
                ...(nextSecret ? { secret: nextSecret } : {}),
              }
            : null,
        }
      : {}),
  };
  const next = updateConfig(normalized);
  res.json({ config: redactForClient(next) });
});

// `secret` is the UI's DRAFT signing secret (typed/generated but not yet
// saved): omitted = sign with the stored one, "" = test unsigned, non-empty
// = sign with it. Without this, Test would silently use the old secret and
// report success against a receiver that can't verify the new one.
const TestWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().optional(),
  // Draft instance id from the Settings form, validated exactly like the
  // persisted one so an unsafe value can't be stamped into the header.
  instanceId: z.string().trim().regex(INSTANCE_ID_PATTERN).optional(),
});

configRouter.post("/test-webhook", async (req, res) => {
  const parsed = TestWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    // Name the field that failed — with `secret` in the schema, a blanket
    // "invalid URL" would mislead a caller whose URL was fine.
    const field = parsed.error.issues[0]?.path.join(".") || "body";
    res.status(400).json({ ok: false, error: `invalid ${field}` });
    return;
  }
  const result = await testWebhook(parsed.data.url, parsed.data.secret, parsed.data.instanceId);
  res.json(result);
});

const ValidateDirSchema = z.object({ path: z.string().min(1) });

configRouter.post("/validate-recordings-dir", (req, res) => {
  const parsed = ValidateDirSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid body" });
    return;
  }
  const p = path.resolve(parsed.data.path);
  try {
    const exists = existsSync(p);
    if (!exists) {
      try {
        mkdirSync(p, { recursive: true });
      } catch (err) {
        res.json({
          ok: false,
          absolutePath: p,
          exists: false,
          error: `cannot create: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    try {
      accessSync(p, constants.W_OK);
    } catch {
      res.json({ ok: false, absolutePath: p, exists: true, writable: false, error: "not writable" });
      return;
    }
    let freeBytes: number | undefined;
    try {
      const st = statfsSync(p);
      freeBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      /* ignore */
    }
    res.json({ ok: true, absolutePath: p, exists: true, writable: true, freeBytes });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

const CompleteSchema = z.object({});

configRouter.post("/complete-setup", (req, res) => {
  const parsed = CompleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body" });
    return;
  }
  const cfg = loadConfig();
  if (!cfg.token) {
    res.status(400).json({ error: "no token configured" });
    return;
  }
  if (!cfg.recordingsDir) {
    res.status(400).json({ error: "recordingsDir not set" });
    return;
  }
  updateConfig({ setupComplete: true });
  poller.start();
  res.json({ ok: true });
});
