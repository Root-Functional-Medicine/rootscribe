import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Hoisted mocks so they bind before profiles.ts imports `homedir`/`platform`
// from node:os and `isWsl` from ../paths.js. Each test sets the return values
// explicitly; leaving them as undefined would surface as a confusing NaN path.
const osMocks = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  platformMock: vi.fn<() => NodeJS.Platform>(),
}));

const pathsMocks = vi.hoisted(() => ({
  isWslMock: vi.fn<() => boolean>(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: osMocks.homedirMock,
    platform: osMocks.platformMock,
  };
});

vi.mock("../paths.js", () => ({
  isWsl: pathsMocks.isWslMock,
}));

const { discoverProfiles } = await import("./profiles.js");

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "rootscribe-profiles-"));
  osMocks.homedirMock.mockReturnValue(fakeHome);
  pathsMocks.isWslMock.mockReturnValue(false);
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

function mkLevelDb(userDataDir: string, profile: string): void {
  const ldb = path.join(userDataDir, profile, "Local Storage", "leveldb");
  mkdirSync(ldb, { recursive: true });
}

describe("discoverProfiles on macOS", () => {
  beforeEach(() => {
    osMocks.platformMock.mockReturnValue("darwin");
  });

  it("finds the Default profile under Chrome's mac Application Support path", () => {
    const chromeDir = path.join(fakeHome, "Library", "Application Support", "Google", "Chrome");
    mkLevelDb(chromeDir, "Default");

    const found = discoverProfiles();

    expect(found).toEqual([
      {
        browser: "Chrome",
        profile: "Default",
        leveldbPath: path.join(chromeDir, "Default", "Local Storage", "leveldb"),
      },
    ]);
  });

  it("returns an empty array when no browser has a populated leveldb directory", () => {
    // Empty fakeHome — no Library/Application Support at all.
    expect(discoverProfiles()).toEqual([]);
  });

  it("sorts profiles with Default first, then lexicographically", () => {
    const chromeDir = path.join(fakeHome, "Library", "Application Support", "Google", "Chrome");
    mkLevelDb(chromeDir, "Profile 2");
    mkLevelDb(chromeDir, "Default");
    mkLevelDb(chromeDir, "Profile 1");

    const found = discoverProfiles();

    expect(found.map((f) => f.profile)).toEqual(["Default", "Profile 1", "Profile 2"]);
  });

  it("ignores directories that are not named `Default` or `Profile <N>`", () => {
    const chromeDir = path.join(fakeHome, "Library", "Application Support", "Google", "Chrome");
    mkLevelDb(chromeDir, "Default");
    // These should be filtered out by listProfiles' name check.
    mkdirSync(path.join(chromeDir, "Guest Profile"), { recursive: true });
    mkdirSync(path.join(chromeDir, "System Profile"), { recursive: true });

    const found = discoverProfiles();
    expect(found).toHaveLength(1);
    expect(found[0]!.profile).toBe("Default");
  });

  it("ignores a profile directory that exists but has no Local Storage/leveldb inside", () => {
    const chromeDir = path.join(fakeHome, "Library", "Application Support", "Google", "Chrome");
    mkdirSync(path.join(chromeDir, "Default"), { recursive: true });
    // No "Local Storage/leveldb" created.

    expect(discoverProfiles()).toEqual([]);
  });

  it("discovers profiles across every supported mac browser (Chrome, Edge, Brave, Arc, Vivaldi)", () => {
    const appSupport = path.join(fakeHome, "Library", "Application Support");
    mkLevelDb(path.join(appSupport, "Google", "Chrome"), "Default");
    mkLevelDb(path.join(appSupport, "Microsoft Edge"), "Default");
    mkLevelDb(path.join(appSupport, "BraveSoftware", "Brave-Browser"), "Default");
    mkLevelDb(path.join(appSupport, "Arc", "User Data"), "Default");
    mkLevelDb(path.join(appSupport, "Vivaldi"), "Default");

    const found = discoverProfiles();
    expect(found.map((f) => f.browser).sort()).toEqual([
      "Arc",
      "Brave",
      "Chrome",
      "Edge",
      "Vivaldi",
    ]);
  });

  it("skips non-directory entries named like profiles (e.g. a stray file called `Default`)", () => {
    const chromeDir = path.join(fakeHome, "Library", "Application Support", "Google", "Chrome");
    mkdirSync(chromeDir, { recursive: true });
    writeFileSync(path.join(chromeDir, "Default"), "not a directory");

    expect(discoverProfiles()).toEqual([]);
  });
});

describe("discoverProfiles on Linux", () => {
  beforeEach(() => {
    osMocks.platformMock.mockReturnValue("linux");
    pathsMocks.isWslMock.mockReturnValue(false);
  });

  it("finds Chrome under ~/.config/google-chrome", () => {
    const chromeDir = path.join(fakeHome, ".config", "google-chrome");
    mkLevelDb(chromeDir, "Default");

    const found = discoverProfiles();
    expect(found).toEqual([
      {
        browser: "Chrome",
        profile: "Default",
        leveldbPath: path.join(chromeDir, "Default", "Local Storage", "leveldb"),
      },
    ]);
  });

  it("supports Chromium alongside Chrome (Chromium-only systems)", () => {
    mkLevelDb(path.join(fakeHome, ".config", "chromium"), "Default");

    const found = discoverProfiles();
    expect(found.map((f) => f.browser)).toEqual(["Chromium"]);
  });
});

describe("discoverProfiles on Windows", () => {
  const originalLocalAppData = process.env.LOCALAPPDATA;

  beforeEach(() => {
    osMocks.platformMock.mockReturnValue("win32");
  });

  afterEach(() => {
    if (originalLocalAppData == null) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
  });

  it("honors process.env.LOCALAPPDATA when set", () => {
    process.env.LOCALAPPDATA = fakeHome;
    mkLevelDb(path.join(fakeHome, "Google", "Chrome", "User Data"), "Default");

    const found = discoverProfiles();
    expect(found).toHaveLength(1);
    expect(found[0]!.browser).toBe("Chrome");
  });

  it("falls back to ~/AppData/Local when LOCALAPPDATA is unset", () => {
    delete process.env.LOCALAPPDATA;
    mkLevelDb(
      path.join(fakeHome, "AppData", "Local", "Microsoft", "Edge", "User Data"),
      "Default",
    );

    const found = discoverProfiles();
    expect(found).toHaveLength(1);
    expect(found[0]!.browser).toBe("Edge");
  });
});

describe("discoverProfiles under WSL", () => {
  beforeEach(() => {
    osMocks.platformMock.mockReturnValue("linux");
    pathsMocks.isWslMock.mockReturnValue(true);
  });

  it("falls back cleanly when /mnt/c/Users is not mounted (typical test environment)", () => {
    // We're not in a real WSL shell, so /mnt/c/Users won't exist. Linux
    // roots alone should still be scanned — this guards against the WSL
    // branch throwing on a missing mount point.
    mkLevelDb(path.join(fakeHome, ".config", "google-chrome"), "Default");

    const found = discoverProfiles();
    expect(found.map((f) => f.browser)).toContain("Chrome");
  });
});
