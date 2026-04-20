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

// The `wslWindowsUsernames()` helper needs `/mnt/c/Users` to exist to get past
// the early-return. On a real CI box we can't create that mount, so we re-mock
// `node:fs` to synthesize one. Each test resets modules + re-imports to get a
// fresh `profiles.ts` binding bound to the patched fs.
describe("wslWindowsUsernames — /mnt/c/Users enumeration (mocked fs)", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  async function withFakeWslFs(
    overrides: {
      existsOf?: (p: string) => boolean;
      readdirOf?: (p: string) => string[] | never;
      isDirOf?: (p: string) => boolean | never;
    } = {},
  ): Promise<typeof import("./profiles.js")> {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (p: string) => {
          if (overrides.existsOf) return overrides.existsOf(p);
          return actual.existsSync(p);
        },
        readdirSync: ((p: string, ...rest: unknown[]) => {
          if (overrides.readdirOf) return overrides.readdirOf(p);
          return (actual.readdirSync as unknown as (p: string, ...rest: unknown[]) => unknown)(
            p,
            ...rest,
          );
        }) as unknown as typeof actual.readdirSync,
        statSync: ((p: string, ...rest: unknown[]) => {
          if (overrides.isDirOf) {
            const isDir = overrides.isDirOf(p);
            return {
              isDirectory: () => isDir,
              isFile: () => !isDir,
            } as unknown as ReturnType<typeof actual.statSync>;
          }
          return (actual.statSync as unknown as (p: string, ...rest: unknown[]) => unknown)(
            p,
            ...rest,
          );
        }) as unknown as typeof actual.statSync,
      };
    });
    return await import("./profiles.js");
  }

  it("appends Windows browser roots under each /mnt/c/Users/<user>/AppData/Local", async () => {
    // The fake fs reports:
    //   - /mnt/c/Users exists
    //   - its readdir returns ["alice", "Default", ".hidden", "bob"]
    //   - alice & bob are directories; Default & .hidden are filtered by name
    //   - Chrome's leveldb exists under alice's LocalAppData only
    const aliceChromeLdb = path.join(
      "/mnt/c/Users/alice/AppData/Local",
      "Google",
      "Chrome",
      "User Data",
      "Default",
      "Local Storage",
      "leveldb",
    );
    const mod = await withFakeWslFs({
      existsOf: (p) => {
        if (p === "/mnt/c/Users") return true;
        if (p === aliceChromeLdb) return true;
        // User-data-dirs themselves exist so listProfiles reaches readdir.
        if (p === path.join("/mnt/c/Users/alice/AppData/Local", "Google", "Chrome", "User Data")) return true;
        return false;
      },
      readdirOf: (p) => {
        if (p === "/mnt/c/Users") return ["alice", "Default", ".hidden", "bob", "README.ini"];
        if (p === path.join("/mnt/c/Users/alice/AppData/Local", "Google", "Chrome", "User Data"))
          return ["Default"];
        return [];
      },
      isDirOf: (p) => {
        if (p === "/mnt/c/Users/alice" || p === "/mnt/c/Users/bob") return true;
        if (p.endsWith("Default")) return true;
        return false;
      },
    });
    osMocks.platformMock.mockReturnValue("linux");
    pathsMocks.isWslMock.mockReturnValue(true);
    osMocks.homedirMock.mockReturnValue("/home/test");

    const found = mod.discoverProfiles();

    // The Chrome leveldb is only present under alice's LocalAppData; bob has
    // no populated browser dirs. Exactly one profile should be discovered.
    expect(found).toHaveLength(1);
    expect(found[0]!.browser).toBe("Chrome");
    expect(found[0]!.leveldbPath).toBe(aliceChromeLdb);
  });

  it("returns [] for wslWindowsUsernames when readdirSync throws (drive unmount mid-read)", async () => {
    const mod = await withFakeWslFs({
      existsOf: (p) => p === "/mnt/c/Users",
      readdirOf: (p) => {
        if (p === "/mnt/c/Users") throw new Error("EIO: drive went away");
        return [];
      },
    });
    osMocks.platformMock.mockReturnValue("linux");
    pathsMocks.isWslMock.mockReturnValue(true);
    osMocks.homedirMock.mockReturnValue("/home/test");

    // The outer catch should swallow the readdir error → empty username list
    // → no Windows roots appended. Linux roots still run, but the fake home
    // has no populated browser dirs either, so the final result is [].
    expect(mod.discoverProfiles()).toEqual([]);
  });

  it("treats a /mnt/c/Users/<user> entry as non-user when statSync throws", async () => {
    // Exercises the inner `catch { return false; }` on statSync(path.join(base, n)):
    // one of the readdir results can't be stat'd, so the filter drops it
    // instead of bubbling the throw out.
    const mod = await withFakeWslFs({
      existsOf: (p) => p === "/mnt/c/Users",
      readdirOf: (p) => (p === "/mnt/c/Users" ? ["borked"] : []),
      isDirOf: (p) => {
        if (p === "/mnt/c/Users/borked") throw new Error("EACCES");
        return false;
      },
    });
    osMocks.platformMock.mockReturnValue("linux");
    pathsMocks.isWslMock.mockReturnValue(true);
    osMocks.homedirMock.mockReturnValue("/home/test");

    // "borked" gets filtered out → no Windows roots appended → no profiles
    // found (and critically no throw escapes).
    expect(mod.discoverProfiles()).toEqual([]);
  });
});

// listProfiles has its own try/catch blocks: the outer `try { readdir... }`
// and an inner `try { statSync... isDirectory() }` per candidate. The normal
// fs-backed tests don't hit those catches (real dirs just read fine), so
// re-mock `node:fs` to force each throw.
describe("listProfiles — error branches (mocked fs)", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  async function withFakeFs(
    overrides: {
      existsOf?: (p: string) => boolean;
      readdirOf?: (p: string) => string[] | never;
      statSyncOf?: (p: string) => { isDirectory: () => boolean } | never;
    } = {},
  ): Promise<typeof import("./profiles.js")> {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        existsSync: (p: string) =>
          overrides.existsOf ? overrides.existsOf(p) : actual.existsSync(p),
        readdirSync: ((p: string, ...rest: unknown[]) =>
          overrides.readdirOf
            ? overrides.readdirOf(p)
            : (actual.readdirSync as unknown as (p: string, ...rest: unknown[]) => unknown)(
                p,
                ...rest,
              )) as unknown as typeof actual.readdirSync,
        statSync: ((p: string, ...rest: unknown[]) => {
          if (overrides.statSyncOf) return overrides.statSyncOf(p);
          return (actual.statSync as unknown as (p: string, ...rest: unknown[]) => unknown)(
            p,
            ...rest,
          );
        }) as unknown as typeof actual.statSync,
      };
    });
    return await import("./profiles.js");
  }

  it("returns [] when readdirSync on the user-data-dir throws (outer catch)", async () => {
    const userDataDir = path.join("/home/test", ".config", "google-chrome");
    const mod = await withFakeFs({
      existsOf: (p) => p === userDataDir,
      readdirOf: (p) => {
        if (p === userDataDir) throw new Error("EACCES: permission denied");
        return [];
      },
    });
    osMocks.platformMock.mockReturnValue("linux");
    pathsMocks.isWslMock.mockReturnValue(false);
    osMocks.homedirMock.mockReturnValue("/home/test");

    expect(mod.discoverProfiles()).toEqual([]);
  });

  it("drops a profile candidate when statSync throws (inner catch)", async () => {
    // readdir surfaces two names. "Default" stat succeeds and IS a directory
    // — but its leveldb doesn't exist. "Profile 1" throws on statSync and
    // must be skipped instead of bubbling.
    const userDataDir = path.join("/home/test", ".config", "google-chrome");
    const defaultLdb = path.join(userDataDir, "Default", "Local Storage", "leveldb");
    const mod = await withFakeFs({
      existsOf: (p) => p === userDataDir || p === defaultLdb,
      readdirOf: (p) => (p === userDataDir ? ["Default", "Profile 1"] : []),
      statSyncOf: (p) => {
        if (p === path.join(userDataDir, "Profile 1")) throw new Error("EACCES");
        return { isDirectory: () => true };
      },
    });
    osMocks.platformMock.mockReturnValue("linux");
    pathsMocks.isWslMock.mockReturnValue(false);
    osMocks.homedirMock.mockReturnValue("/home/test");

    const found = mod.discoverProfiles();
    expect(found.map((f) => f.profile)).toEqual(["Default"]);
  });
});
