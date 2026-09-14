import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
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
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    loadFailed = false;
    cached = { ...DEFAULT_CONFIG, ...parsed };
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
  writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 });
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
    logger.warn(
      { instanceId: cfg.instanceId },
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
  saveConfig({ ...cfg, instanceId });
  logger.info({ instanceId }, "generated instance id for outbound webhooks");
  return instanceId;
}

export function resetConfigCache(): void {
  cached = null;
  loadFailed = false;
}
