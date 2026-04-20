import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configDir,
  ensureConfigDir,
  settingsPath,
  dbPath,
  logPath,
  lockPath,
} from "./paths.js";

describe("configDir (env override)", () => {
  const original = process.env.ROOTSCRIBE_CONFIG_DIR;

  beforeEach(() => {
    process.env.ROOTSCRIBE_CONFIG_DIR = "/custom/rootscribe/dir";
  });

  afterEach(() => {
    if (original == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
    else process.env.ROOTSCRIBE_CONFIG_DIR = original;
  });

  it("honors ROOTSCRIBE_CONFIG_DIR over the platform default", () => {
    expect(configDir()).toBe("/custom/rootscribe/dir");
  });

  it("ignores an empty ROOTSCRIBE_CONFIG_DIR and falls back to a platform default", () => {
    process.env.ROOTSCRIBE_CONFIG_DIR = "";
    const dir = configDir();
    expect(dir).not.toBe("");
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it("derives settingsPath, dbPath, logPath, and lockPath from configDir", () => {
    expect(settingsPath()).toBe(path.join("/custom/rootscribe/dir", "settings.json"));
    expect(dbPath()).toBe(path.join("/custom/rootscribe/dir", "state.sqlite"));
    expect(logPath()).toBe(path.join("/custom/rootscribe/dir", "rootscribe.log"));
    expect(lockPath()).toBe(path.join("/custom/rootscribe/dir", "rootscribe.lock"));
  });
});

describe("ensureConfigDir", () => {
  let tmpRoot: string;
  const original = process.env.ROOTSCRIBE_CONFIG_DIR;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "rootscribe-paths-test-"));
  });

  afterEach(() => {
    if (original == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
    else process.env.ROOTSCRIBE_CONFIG_DIR = original;
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates the directory if missing and returns its path", () => {
    const target = path.join(tmpRoot, "nested", "rootscribe");
    process.env.ROOTSCRIBE_CONFIG_DIR = target;
    expect(existsSync(target)).toBe(false);
    const result = ensureConfigDir();
    expect(result).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it("is idempotent when called twice", () => {
    const target = path.join(tmpRoot, "rootscribe");
    process.env.ROOTSCRIBE_CONFIG_DIR = target;
    ensureConfigDir();
    expect(() => ensureConfigDir()).not.toThrow();
    expect(existsSync(target)).toBe(true);
  });
});

// The real suite runs on the Vitest worker's host platform, so the
// win32 / linux branches of configDir() + isWsl() stay uncovered. These
// tests stub node:os::platform via vi.doMock + vi.resetModules to force
// each branch — same pattern used in inbox-mcp/src/paths.test.ts.
describe("configDir — platform branches (mocked)", () => {
  const originalEnv = {
    ROOTSCRIBE_CONFIG_DIR: process.env.ROOTSCRIBE_CONFIG_DIR,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };

  beforeEach(() => {
    delete process.env.ROOTSCRIBE_CONFIG_DIR;
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (originalEnv.ROOTSCRIBE_CONFIG_DIR == null)
      delete process.env.ROOTSCRIBE_CONFIG_DIR;
    else process.env.ROOTSCRIBE_CONFIG_DIR = originalEnv.ROOTSCRIBE_CONFIG_DIR;
    if (originalEnv.APPDATA == null) delete process.env.APPDATA;
    else process.env.APPDATA = originalEnv.APPDATA;
    if (originalEnv.XDG_CONFIG_HOME == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    vi.doUnmock("node:os");
    vi.resetModules();
  });

  async function withOs(
    plat: NodeJS.Platform,
    fake: { home?: string; procVersion?: string } = {},
  ): Promise<typeof import("./paths.js")> {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        platform: () => plat,
        homedir: () => fake.home ?? "/home/fake",
      };
    });
    if (fake.procVersion !== undefined) {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>(
          "node:fs",
        );
        return {
          ...actual,
          readFileSync: (pathArg: string) => {
            if (pathArg === "/proc/version") return fake.procVersion;
            return actual.readFileSync(pathArg);
          },
        };
      });
    }
    return await import("./paths.js");
  }

  it("darwin → ~/Library/Application Support/rootscribe", async () => {
    const mod = await withOs("darwin", { home: "/Users/alice" });
    expect(mod.configDir()).toBe(
      "/Users/alice/Library/Application Support/rootscribe",
    );
  });

  it("win32 with APPDATA set → %APPDATA%/rootscribe", async () => {
    process.env.APPDATA = "C:\\Users\\alice\\AppData\\Roaming";
    const mod = await withOs("win32", { home: "C:\\Users\\alice" });
    expect(mod.configDir()).toBe(
      path.join("C:\\Users\\alice\\AppData\\Roaming", "rootscribe"),
    );
  });

  it("win32 without APPDATA → ~/AppData/Roaming/rootscribe", async () => {
    delete process.env.APPDATA;
    const mod = await withOs("win32", { home: "C:\\Users\\alice" });
    expect(mod.configDir()).toBe(
      path.join("C:\\Users\\alice", "AppData", "Roaming", "rootscribe"),
    );
  });

  it("linux with XDG_CONFIG_HOME set → $XDG_CONFIG_HOME/rootscribe", async () => {
    process.env.XDG_CONFIG_HOME = "/opt/xdg";
    const mod = await withOs("linux", { home: "/home/alice" });
    expect(mod.configDir()).toBe("/opt/xdg/rootscribe");
  });

  it("linux without XDG_CONFIG_HOME → ~/.config/rootscribe", async () => {
    delete process.env.XDG_CONFIG_HOME;
    const mod = await withOs("linux", { home: "/home/alice" });
    expect(mod.configDir()).toBe("/home/alice/.config/rootscribe");
  });

  it("linux with empty-string XDG_CONFIG_HOME → ~/.config/rootscribe", async () => {
    process.env.XDG_CONFIG_HOME = "";
    const mod = await withOs("linux", { home: "/home/alice" });
    expect(mod.configDir()).toBe("/home/alice/.config/rootscribe");
  });
});

describe("isWsl — platform branches (mocked)", () => {
  afterEach(() => {
    vi.doUnmock("node:os");
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  async function withOs(
    plat: NodeJS.Platform,
    procVersion?: string,
  ): Promise<typeof import("./paths.js")> {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => plat };
    });
    if (procVersion !== undefined) {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>(
          "node:fs",
        );
        return {
          ...actual,
          readFileSync: (pathArg: string, enc?: unknown) => {
            if (pathArg === "/proc/version") return procVersion;
            return actual.readFileSync(
              pathArg,
              enc as Parameters<typeof actual.readFileSync>[1],
            );
          },
        };
      });
    }
    return await import("./paths.js");
  }

  it("returns false immediately on non-linux platforms", async () => {
    const mod = await withOs("darwin");
    expect(mod.isWsl()).toBe(false);
  });

  it("returns true on linux when /proc/version contains 'microsoft'", async () => {
    const mod = await withOs(
      "linux",
      "Linux version 5.10.16.3-microsoft-standard-WSL2",
    );
    expect(mod.isWsl()).toBe(true);
  });

  it("returns false on linux when /proc/version does not mention microsoft", async () => {
    const mod = await withOs("linux", "Linux version 6.8.0-1018-gcp");
    expect(mod.isWsl()).toBe(false);
  });

  it("returns false on linux when /proc/version is unreadable (fs throw swallowed)", async () => {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, platform: () => "linux" as const };
    });
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        readFileSync: (pathArg: string, enc?: unknown) => {
          if (pathArg === "/proc/version") {
            throw new Error("ENOENT");
          }
          return actual.readFileSync(
            pathArg,
            enc as Parameters<typeof actual.readFileSync>[1],
          );
        },
      };
    });
    const mod = await import("./paths.js");
    expect(mod.isWsl()).toBe(false);
  });
});
