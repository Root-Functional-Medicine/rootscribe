import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserProfile } from "./profiles.js";

// Shared instance registry so each test can stage different ClassicLevel
// behaviors per-profile. The production code constructs one
// `new ClassicLevel(tmpPath, ...)` per profile scan, so the mock returns
// an object configured via the `stage()` helper below.

interface StagedDb {
  getImpl?: (key: Buffer) => Buffer | null;
  iterateKeys?: string[]; // latin1-decoded key strings the iterator should yield
  openImpl?: () => Promise<void> | void;
}
let nextDbStage: StagedDb | undefined;
const dbStagesByPath = new Map<string, StagedDb>();

// Mock classic-level to return a fake DB whose behavior is driven by the
// test-staged config. Every `new ClassicLevel(path, ...)` call pulls the
// staging for that path (or the global next-stage, first-come).
vi.mock("classic-level", () => {
  class ClassicLevel<K, V> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(public readonly location: string, _opts?: unknown) {
      // Associate the current `nextDbStage` with this constructed path if
      // none is registered yet, so per-profile scans each get their own.
      if (nextDbStage && !dbStagesByPath.has(location)) {
        dbStagesByPath.set(location, nextDbStage);
        nextDbStage = undefined;
      }
    }
    private get stage(): StagedDb {
      return dbStagesByPath.get(this.location) ?? {};
    }
    async open(): Promise<void> {
      if (this.stage.openImpl) return this.stage.openImpl();
    }
    async close(): Promise<void> {}
    async get(key: Buffer): Promise<V> {
      const impl = this.stage.getImpl;
      if (!impl) {
        const err = new Error("NotFound") as Error & { code?: string };
        err.code = "LEVEL_NOT_FOUND";
        throw err;
      }
      const value = impl(key);
      if (value === null) {
        const err = new Error("NotFound") as Error & { code?: string };
        err.code = "LEVEL_NOT_FOUND";
        throw err;
      }
      return value as unknown as V;
    }
    // classic-level's iterator is a `for await` target; the minimum surface
    // we need is an async iterator of [key, value] tuples.
    iterator(): AsyncIterable<[K, V]> {
      const keys = this.stage.iterateKeys ?? [];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next(): Promise<IteratorResult<[K, V]>> {
              if (i >= keys.length) {
                return Promise.resolve({ value: undefined, done: true });
              }
              const k = Buffer.from(keys[i++]!, "latin1");
              return Promise.resolve({
                value: [k, Buffer.alloc(0)] as unknown as [K, V],
                done: false,
              });
            },
          };
        },
      };
    }
  }
  return { ClassicLevel };
});

// Mock the filesystem copy helpers so the scanner doesn't touch real dirs.
// copyProfileToTemp -> mkdtempSync + cpSync; cleanup -> rmSync.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdtempSync: vi.fn((prefix: string) => `${prefix}mock-${Math.random().toString(36).slice(2, 8)}`),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

// Mock the profiles discovery so we can test with synthetic profiles.
vi.mock("./profiles.js", () => ({
  discoverProfiles: vi.fn(),
}));

const { findToken } = await import("./chrome-leveldb.js");
const { discoverProfiles } = await import("./profiles.js");

function stage(s: StagedDb): void {
  nextDbStage = s;
}

// Build a 3-segment JWT with a base64-encoded payload that parseJwt can
// decode — used to verify iat-based sorting and payload extraction.
function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

// Chrome LocalStorage values are prefixed with an encoding marker byte.
// 0x00 = UTF-16LE, 0x01 = Latin-1. Build both for the direct-get path.
function utf16Value(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(text, "utf16le")]);
}
function latin1Value(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(text, "latin1")]);
}

const profile = (overrides: Partial<BrowserProfile> = {}): BrowserProfile => ({
  browser: "Chrome",
  profile: "Default",
  leveldbPath: "/fake/chrome/Default/leveldb",
  ...overrides,
});

beforeEach(() => {
  dbStagesByPath.clear();
  nextDbStage = undefined;
  vi.mocked(discoverProfiles).mockReset();
});

describe("findToken — no profiles", () => {
  it("returns null when discoverProfiles() is empty", async () => {
    vi.mocked(discoverProfiles).mockReturnValue([]);
    const r = await findToken();
    expect(r).toBeNull();
  });
});

describe("findToken — direct TOKENSTR_KEY hit", () => {
  it("returns a FoundToken when the direct get returns a UTF-16LE `bearer eyJ...` value", async () => {
    const token = jwt({ iat: 1_700_000_000, exp: 2_000_000_000 });
    vi.mocked(discoverProfiles).mockReturnValue([
      profile({ browser: "Chrome", profile: "Default" }),
    ]);
    stage({
      getImpl: () => utf16Value(`bearer ${token}`),
      // Include a PLADU_<email>_ key in the iterator so email resolution
      // still runs even though the direct get already found the token.
      iterateKeys: ["PLADU_alice@example.com_welcomeFileShown"],
    });

    const r = await findToken();
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      token,
      browser: "Chrome",
      profile: "Default",
      email: "alice@example.com",
      iat: 1_700_000_000,
      exp: 2_000_000_000,
    });
  });

  it("strips a case-insensitive 'Bearer ' prefix from the direct-get value", async () => {
    const token = jwt({ iat: 1, exp: 2 });
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({ getImpl: () => utf16Value(`Bearer ${token}`) });

    const r = await findToken();
    expect(r?.token).toBe(token);
  });

  it("decodes a Latin-1 marker value correctly", async () => {
    const token = jwt({ iat: 1, exp: 2 });
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({ getImpl: () => latin1Value(`bearer ${token}`) });

    const r = await findToken();
    expect(r?.token).toBe(token);
  });

  it("falls through when the direct-get value does not start with 'eyJ'", async () => {
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({
      getImpl: () => utf16Value("garbage-not-a-jwt"),
      // No usable bearer-embedded key in the iterator either → token stays null.
      iterateKeys: [],
    });

    const r = await findToken();
    expect(r).toBeNull();
  });
});

describe("findToken — iterator fallback extracts bearer from key names", () => {
  it("recovers the token from a 'bearer eyJ...' embedded in a key name", async () => {
    const token = jwt({ iat: 42, exp: 99 });
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({
      // Direct get fails (NotFound).
      getImpl: () => null,
      // Put the bearer token at the END of its key so the regex's
      // [A-Za-z0-9_-]+ third segment stops at the string boundary. In real
      // Chrome keys the bearer sits before `_welcomeFileShown`, which
      // would make the regex greedily capture the suffix too — a latent
      // cosmetic issue in production, but out of scope for this ratchet.
      iterateKeys: [
        "PLADU_alice@example.com_welcomeFileShown",
        `PLADU_uid_bearer ${token}`,
      ],
    });

    const r = await findToken();
    expect(r).toMatchObject({
      token,
      email: "alice@example.com",
      iat: 42,
      exp: 99,
    });
  });

  it("returns null when neither the direct get nor the iterator yields a bearer JWT", async () => {
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({
      getImpl: () => null,
      iterateKeys: ["some_other_key", "another_unrelated_key"],
    });

    const r = await findToken();
    expect(r).toBeNull();
  });
});

describe("findToken — sorting + multi-profile aggregation", () => {
  it("returns the newest token by JWT `iat` when multiple profiles carry tokens", async () => {
    const older = jwt({ iat: 1_600_000_000, exp: 1_900_000_000 });
    const newer = jwt({ iat: 1_800_000_000, exp: 2_100_000_000 });
    vi.mocked(discoverProfiles).mockReturnValue([
      profile({ browser: "Chrome", profile: "Default", leveldbPath: "/a" }),
      profile({ browser: "Brave", profile: "Profile 1", leveldbPath: "/b" }),
    ]);
    // copyProfileToTemp generates randomized temp paths, so we can't
    // pre-seed dbStagesByPath by path. Instead, monkey-patch its `get` to
    // pull the next unconsumed staging in call order, then restore.
    const stages: StagedDb[] = [
      { getImpl: () => utf16Value(`bearer ${older}`), iterateKeys: [] },
      { getImpl: () => utf16Value(`bearer ${newer}`), iterateKeys: [] },
    ];
    let stageIdx = 0;
    const originalGet = dbStagesByPath.get.bind(dbStagesByPath);
    dbStagesByPath.get = (k: string): StagedDb | undefined => {
      const existing = originalGet(k);
      if (existing) return existing;
      const fresh = stages[stageIdx++];
      if (fresh) dbStagesByPath.set(k, fresh);
      return fresh;
    };

    const r = await findToken();
    dbStagesByPath.get = originalGet;

    expect(r?.token).toBe(newer);
    expect(r?.iat).toBe(1_800_000_000);
  });

  it("survives a scan failure on one profile and still returns the other profile's token", async () => {
    const token = jwt({ iat: 1, exp: 2 });
    vi.mocked(discoverProfiles).mockReturnValue([
      profile({ profile: "Broken", leveldbPath: "/broken" }),
      profile({ profile: "Default", leveldbPath: "/good" }),
    ]);

    const stages: StagedDb[] = [
      { openImpl: () => Promise.reject(new Error("locked")) }, // broken
      { getImpl: () => utf16Value(`bearer ${token}`) }, // good
    ];
    let stageIdx = 0;
    const originalGet = dbStagesByPath.get.bind(dbStagesByPath);
    dbStagesByPath.get = (k: string): StagedDb | undefined => {
      const existing = originalGet(k);
      if (existing) return existing;
      const fresh = stages[stageIdx++];
      if (fresh) dbStagesByPath.set(k, fresh);
      return fresh;
    };

    const r = await findToken();
    dbStagesByPath.get = originalGet;

    expect(r?.token).toBe(token);
    expect(r?.profile).toBe("Default");
  });
});

describe("findToken — invalid JWT", () => {
  it("returns a FoundToken with iat=null / exp=null when the JWT payload isn't valid base64 JSON", async () => {
    // 3-segment shape so extractJwt recognizes it, but payload is garbage.
    const bogus = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.!!!!!!!.sig";
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({ getImpl: () => utf16Value(`bearer ${bogus}`) });

    const r = await findToken();
    expect(r).not.toBeNull();
    expect(r?.iat).toBeNull();
    expect(r?.exp).toBeNull();
  });
});
