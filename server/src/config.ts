import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, isValidInstanceId, type AppConfig } from "@rootscribe/shared";
import { ensureConfigDir, settingsPath } from "./paths.js";
import { logger } from "./logger.js";

let cached: AppConfig | null = null;
// True when settings.json existed but could not be parsed. loadConfig() then
// serves DEFAULT_CONFIG, and automatic writers (ensureInstanceId) must not
// persist over the corrupt-but-possibly-recoverable file. Explicit operator
// saves (updateConfig from the UI) are still allowed to repair it.
let loadFailed = false;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureConfigDir();
  const p = settingsPath();
  if (!existsSync(p)) {
    loadFailed = false;
    cached = { ...DEFAULT_CONFIG };
    return cached;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const parsed: unknown = JSON.parse(raw);
    // Valid JSON that is not a plain object (null, an array, a string, a
    // number) is just as corrupt as unparseable text: spreading it would
    // yield defaults (or index keys / characters), and automatic writers
    // would then overwrite a file an operator could still repair by hand.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`settings.json must be a JSON object, got ${
        parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed
      }`);
    }
    loadFailed = false;
    cached = { ...DEFAULT_CONFIG, ...(parsed as Partial<AppConfig>) };
    return cached;
  } catch (err) {
    logger.error({ err, path: p }, "failed to parse settings.json — using defaults");
    loadFailed = true;
    cached = { ...DEFAULT_CONFIG };
    return cached;
  }
}

export function saveConfig(next: AppConfig): void {
  ensureConfigDir();
  const p = settingsPath();
  // Atomic replace: write a sibling temp file, then rename it over the
  // target. writeFileSync on the target itself truncates first, so a full
  // disk or an interrupted process (e.g. during the automatic
  // ensureInstanceId() write at startup) could leave a half-written or
  // empty settings.json — losing a valid token/webhook configuration. With
  // temp + rename the old file survives any failure before the rename.
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up (the temp write itself failed) or already gone.
    }
    throw err;
  }
  try {
    chmodSync(p, 0o600);
  } catch {
    // Best-effort; Windows will ignore.
  }
  loadFailed = false;
  cached = next;
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

/**
 * Return this install's stable instance identifier, minting and persisting a
 * UUID the first time it is needed. Called once at server startup so the id
 * shows up in Settings immediately, and again by every outbound webhook so
 * `x-rootscribe-instance` is present even if settings.json was hand-edited
 * to drop the field. Idempotent: an existing (possibly operator-chosen)
 * value is returned untouched — provided it passes the same header-safe
 * check POST /api/config enforces; a hand-edited value that fails it would
 * make undici reject every delivery, so it is replaced by a fresh UUID.
 *
 * When settings.json exists but failed to parse, the id is minted in memory
 * only (stable for this process) and NOT persisted — writing defaults plus a
 * UUID over the corrupt file would destroy whatever an operator could still
 * recover from it by hand.
 */
export function ensureInstanceId(): string {
  const cfg = loadConfig();
  if (isValidInstanceId(cfg.instanceId)) return cfg.instanceId;
  if (cfg.instanceId != null) {
    // Log only sanitized metadata: the value is untrusted file content and
    // a hand-edited object/array would otherwise be serialized (nested
    // contents included) into rootscribe.log.
    const rejected: unknown = cfg.instanceId;
    logger.warn(
      {
        type: Array.isArray(rejected) ? "array" : typeof rejected,
        ...(typeof rejected === "string" ? { length: rejected.length } : {}),
      },
      "persisted instanceId is not a header-safe token — replacing it with a generated id",
    );
  }
  const instanceId = randomUUID();
  if (loadFailed) {
    cached = { ...cfg, instanceId };
    logger.warn(
      { instanceId, path: settingsPath() },
      "settings.json is unreadable — using an in-memory instance id and leaving the file untouched",
    );
    return instanceId;
  }
  try {
    saveConfig({ ...cfg, instanceId });
    logger.info({ instanceId }, "generated instance id for outbound webhooks");
  } catch (err) {
    // A read-only file or full disk must not become a startup crash (this
    // runs before listen()) or a delivery outage (it runs inside fireRaw's
    // try, before fetch). Keep the id in memory — stable for the process —
    // and let the operator fix persistence separately.
    cached = { ...cfg, instanceId };
    logger.error(
      { err, instanceId, path: settingsPath() },
      "could not persist the generated instance id — using it in memory for this process only",
    );
  }
  return instanceId;
}

export function resetConfigCache(): void {
  cached = null;
  loadFailed = false;
}
