import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, type AppConfig } from "@rootscribe/shared";
import { ensureConfigDir, settingsPath } from "./paths.js";
import { logger } from "./logger.js";

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureConfigDir();
  const p = settingsPath();
  if (!existsSync(p)) {
    cached = { ...DEFAULT_CONFIG };
    return cached;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    cached = { ...DEFAULT_CONFIG, ...parsed };
    return cached;
  } catch (err) {
    logger.error({ err, path: p }, "failed to parse settings.json — using defaults");
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
 * value is returned untouched.
 */
export function ensureInstanceId(): string {
  const cfg = loadConfig();
  if (cfg.instanceId) return cfg.instanceId;
  const instanceId = randomUUID();
  saveConfig({ ...cfg, instanceId });
  logger.info({ instanceId }, "generated instance id for outbound webhooks");
  return instanceId;
}

export function resetConfigCache(): void {
  cached = null;
}
