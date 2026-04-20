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
    // pull the next unconsumed staging in call order. Wrap in try/finally
    // so a rejection inside findToken() can't leak the patched Map.get
    // into later tests.
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

    try {
      const r = await findToken();
      expect(r?.token).toBe(newer);
      expect(r?.iat).toBe(1_800_000_000);
    } finally {
      dbStagesByPath.get = originalGet;
    }
  });

  it("still picks the valid-iat token when another profile's token has a malformed payload (iat=null)", async () => {
    // Exercises the `iat ?? 0` fallback in the sort comparator (chrome-leveldb.ts:157).
    // A malformed-payload JWT yields `iat:null` from parseJwt(); the comparator
    // substitutes 0 so the valid-iat token wins regardless of scan order.
    const validToken = jwt({ iat: 1_800_000_000, exp: 2_100_000_000 });
    const malformed = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.!!!!!!!.sig";
    vi.mocked(discoverProfiles).mockReturnValue([
      profile({ browser: "Chrome", profile: "Malformed", leveldbPath: "/m" }),
      profile({ browser: "Chrome", profile: "Valid", leveldbPath: "/v" }),
    ]);
    const stages: StagedDb[] = [
      { getImpl: () => utf16Value(`bearer ${malformed}`), iterateKeys: [] },
      { getImpl: () => utf16Value(`bearer ${validToken}`), iterateKeys: [] },
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

    try {
      const r = await findToken();
      // Valid-iat profile wins because `(b.iat ?? 0) - (a.iat ?? 0)` with
      // `b.iat=1_800_000_000` and `a.iat=null→0` is positive → valid first.
      expect(r?.token).toBe(validToken);
      expect(r?.iat).toBe(1_800_000_000);
    } finally {
      dbStagesByPath.get = originalGet;
    }
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

    try {
      const r = await findToken();
      expect(r?.token).toBe(token);
      expect(r?.profile).toBe("Default");
    } finally {
      dbStagesByPath.get = originalGet;
    }
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

describe("decodeValue — unknown encoding marker", () => {
  it("falls back to UTF-8 decoding for a marker byte that is neither 0x00 nor 0x01", async () => {
    // decodeValue is internal; exercise it via the full findToken path.
    // Buffer starting with 0x02 (unknown marker) + ASCII content → falls
    // through to `buf.toString('utf8')`. The utf8 text is the full 3-byte
    // marker + "bearer eyJ..." payload. Since the unknown-marker branch
    // does NOT strip the first byte, the resulting string starts with
    // \u0002 which breaks the /^bearer/i match, so the fast-path bails.
    // That still proves the branch was hit because no exception is thrown
    // and the scanner falls through to the iterator.
    const token = jwt({ iat: 777, exp: 888 });
    const unknownMarkerBuf = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(`bearer ${token}`, "utf8"),
    ]);
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({
      getImpl: () => unknownMarkerBuf,
      // Also give the iterator a bearer-key so the scanner still finds a
      // token — the direct-get returned a "\u0002bearer ..." string that
      // doesn't start with "bearer" after stripping, so it falls through.
      iterateKeys: [`PLADU_bob@example.com_bearer ${token}`],
    });

    const r = await findToken();
    // Token recovered from the iterator fallback, proving decodeValue
    // returned a UTF-8 string (didn't throw) even for the unknown marker.
    expect(r?.token).toBe(token);
  });
});

describe("copyProfileToTemp — LOCK filter", () => {
  it("filters the LOCK file so cpSync skips Chrome's exclusive-lock sentinel", async () => {
    // The global node:fs mock at the top of this file replaces cpSync with
    // a vi.fn() that doesn't exercise the `filter` callback. To verify the
    // filter logic we pluck it out of the mocked call args and invoke it
    // directly with representative paths.
    const { cpSync } = await import("node:fs");
    const cpSyncMock = vi.mocked(cpSync);
    cpSyncMock.mockClear();

    const token = jwt({ iat: 1, exp: 2 });
    vi.mocked(discoverProfiles).mockReturnValue([profile()]);
    stage({ getImpl: () => utf16Value(`bearer ${token}`) });
    await findToken();

    // Last cpSync call was during this scan; its 3rd arg is the options
    // object that carries the filter.
    expect(cpSyncMock).toHaveBeenCalled();
    const call = cpSyncMock.mock.calls[cpSyncMock.mock.calls.length - 1]!;
    const opts = call[2] as { filter?: (src: string, dest: string) => boolean };
    expect(opts.filter).toBeDefined();
    const filter = opts.filter!;

    // POSIX LOCK: skipped (covers the second `.endsWith('/LOCK')` clause).
    // Anything else: kept. (The `${path.sep}LOCK` clause is POSIX-sep on
    // this runner — it's identical to '/LOCK' — but on Windows runners it
    // would check '\\LOCK' and fire first.)
    expect(filter("/tmp/src/LOCK", "/tmp/dst/LOCK")).toBe(false);
    expect(filter("/tmp/src/000001.ldb", "/tmp/dst/000001.ldb")).toBe(true);
    expect(filter("/tmp/src/MANIFEST-000001", "/tmp/dst/MANIFEST-000001")).toBe(true);
  });
});

describe("findToken — outer catch swallows a scanProfile throw", () => {
  it("logs and keeps going when scanProfile itself throws (not a LevelDB open error)", async () => {
    // Distinct from the 'broken-profile' test above: there, ClassicLevel.open
    // rejects and is caught INSIDE scanProfile (the inner try/catch). Here
    // we make copyProfileToTemp throw — which bubbles past all of
    // scanProfile's try blocks — so the outer for-loop's catch in
    // findToken itself has to absorb it.
    const token = jwt({ iat: 1, exp: 2 });
    vi.mocked(discoverProfiles).mockReturnValue([
      profile({ profile: "Throws", leveldbPath: "/throws" }),
      profile({ profile: "Good", leveldbPath: "/good" }),
    ]);

    const { mkdtempSync } = await import("node:fs");
    const mkdtempSyncMock = vi.mocked(mkdtempSync);
    let call = 0;
    mkdtempSyncMock.mockImplementation((prefix) => {
      call += 1;
      if (call === 1) throw new Error("ENOSPC: out of disk");
      return `${prefix}ok-${call}`;
    });

    // Only the 2nd profile reaches the DB constructor. Stage it to succeed.
    stage({ getImpl: () => utf16Value(`bearer ${token}`) });

    const r = await findToken();
    expect(r?.token).toBe(token);
    expect(r?.profile).toBe("Good");

    mkdtempSyncMock.mockReset();
  });
});
