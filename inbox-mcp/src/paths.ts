import { homedir, platform } from "node:os";
import path from "node:path";

// Mirrors server/src/paths.ts so we read the same state.sqlite RootScribe writes to.
// Kept as a small duplicate (rather than shared-package import) to minimize
// upstream merge conflict surface.
export function configDir(): string {
  const explicit = process.env.ROOTSCRIBE_CONFIG_DIR;
  if (explicit && explicit.length > 0) return explicit;

  const plat = platform();
  if (plat === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "rootscribe");
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
    return path.join(appData, "rootscribe");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".config");
  return path.join(base, "rootscribe");
}

export function dbPath(): string {
  return path.join(configDir(), "state.sqlite");
}
