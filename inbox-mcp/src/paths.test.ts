import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { configDir, dbPath } from "./paths.js";

describe("configDir", () => {
  const original = process.env.ROOTSCRIBE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.ROOTSCRIBE_CONFIG_DIR;
  });

  afterEach(() => {
    if (original == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
    else process.env.ROOTSCRIBE_CONFIG_DIR = original;
  });

  it("returns ROOTSCRIBE_CONFIG_DIR when set", () => {
    process.env.ROOTSCRIBE_CONFIG_DIR = "/tmp/rootscribe-override";
    expect(configDir()).toBe("/tmp/rootscribe-override");
  });

  it("ignores an empty ROOTSCRIBE_CONFIG_DIR and falls back to platform default", () => {
    process.env.ROOTSCRIBE_CONFIG_DIR = "";
    const dir = configDir();
    expect(dir).not.toBe("");
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it("returns an absolute path on every supported platform", () => {
    // No override — exercises the real platform() branch.
    expect(path.isAbsolute(configDir())).toBe(true);
  });
});

describe("dbPath", () => {
  const original = process.env.ROOTSCRIBE_CONFIG_DIR;

  afterEach(() => {
    if (original == null) delete process.env.ROOTSCRIBE_CONFIG_DIR;
    else process.env.ROOTSCRIBE_CONFIG_DIR = original;
  });

  it("is state.sqlite inside the configured directory", () => {
    process.env.ROOTSCRIBE_CONFIG_DIR = "/tmp/rootscribe-override";
    expect(dbPath()).toBe(path.join("/tmp/rootscribe-override", "state.sqlite"));
  });
});

// The real suite runs on whichever platform Vitest happens to be on (macOS
// in CI), so the win32 + linux branches stay uncovered without explicit
// module mocking. These tests stub node:os::platform so every branch of
// configDir() gets exercised — which also bumps paths.ts coverage from
// ~62% lines to 100% without touching production code.
describe("configDir — platform branches (mocked os.platform)", () => {
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
    if (originalEnv.ROOTSCRIBE_CONFIG_DIR == null) {
      delete process.env.ROOTSCRIBE_CONFIG_DIR;
    } else {
      process.env.ROOTSCRIBE_CONFIG_DIR = originalEnv.ROOTSCRIBE_CONFIG_DIR;
    }
    if (originalEnv.APPDATA == null) delete process.env.APPDATA;
    else process.env.APPDATA = originalEnv.APPDATA;
    if (originalEnv.XDG_CONFIG_HOME == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    vi.doUnmock("node:os");
    vi.resetModules();
  });

  async function withPlatform(
    plat: NodeJS.Platform,
    fake: { home?: string } = {},
  ): Promise<typeof import("./paths.js")> {
    // Re-import paths.ts under a fresh module cache so the mocked
    // os::platform is picked up on its next call.
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        platform: () => plat,
        homedir: () => fake.home ?? "/home/fake",
      };
    });
    return await import("./paths.js");
  }

  it("darwin → ~/Library/Application Support/rootscribe", async () => {
    const mod = await withPlatform("darwin", { home: "/Users/alice" });
    expect(mod.configDir()).toBe(
      "/Users/alice/Library/Application Support/rootscribe",
    );
  });

  it("win32 → %APPDATA%\\rootscribe when APPDATA is set", async () => {
    process.env.APPDATA = "C:\\Users\\alice\\AppData\\Roaming";
    const mod = await withPlatform("win32", { home: "C:\\Users\\alice" });
    expect(mod.configDir()).toBe(
      path.join("C:\\Users\\alice\\AppData\\Roaming", "rootscribe"),
    );
  });

  it("win32 → falls back to ~/AppData/Roaming when APPDATA is unset", async () => {
    delete process.env.APPDATA;
    const mod = await withPlatform("win32", { home: "C:\\Users\\alice" });
    expect(mod.configDir()).toBe(
      path.join("C:\\Users\\alice", "AppData", "Roaming", "rootscribe"),
    );
  });

  it("linux → $XDG_CONFIG_HOME/rootscribe when set", async () => {
    process.env.XDG_CONFIG_HOME = "/opt/xdg";
    const mod = await withPlatform("linux", { home: "/home/alice" });
    expect(mod.configDir()).toBe("/opt/xdg/rootscribe");
  });

  it("linux → ~/.config/rootscribe when XDG_CONFIG_HOME is unset", async () => {
    delete process.env.XDG_CONFIG_HOME;
    const mod = await withPlatform("linux", { home: "/home/alice" });
    expect(mod.configDir()).toBe("/home/alice/.config/rootscribe");
  });

  it("linux → ~/.config/rootscribe when XDG_CONFIG_HOME is empty string", async () => {
    process.env.XDG_CONFIG_HOME = "";
    const mod = await withPlatform("linux", { home: "/home/alice" });
    expect(mod.configDir()).toBe("/home/alice/.config/rootscribe");
  });
});
