import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  const original = process.env.APPLAUD_CONFIG_DIR;

  beforeEach(() => {
    process.env.APPLAUD_CONFIG_DIR = "/custom/applaud/dir";
  });

  afterEach(() => {
    if (original == null) delete process.env.APPLAUD_CONFIG_DIR;
    else process.env.APPLAUD_CONFIG_DIR = original;
  });

  it("honors APPLAUD_CONFIG_DIR over the platform default", () => {
    expect(configDir()).toBe("/custom/applaud/dir");
  });

  it("ignores an empty APPLAUD_CONFIG_DIR and falls back to a platform default", () => {
    process.env.APPLAUD_CONFIG_DIR = "";
    const dir = configDir();
    expect(dir).not.toBe("");
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it("derives settingsPath, dbPath, logPath, and lockPath from configDir", () => {
    expect(settingsPath()).toBe(path.join("/custom/applaud/dir", "settings.json"));
    expect(dbPath()).toBe(path.join("/custom/applaud/dir", "state.sqlite"));
    expect(logPath()).toBe(path.join("/custom/applaud/dir", "applaud.log"));
    expect(lockPath()).toBe(path.join("/custom/applaud/dir", "applaud.lock"));
  });
});

describe("ensureConfigDir", () => {
  let tmpRoot: string;
  const original = process.env.APPLAUD_CONFIG_DIR;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "applaud-paths-test-"));
  });

  afterEach(() => {
    if (original == null) delete process.env.APPLAUD_CONFIG_DIR;
    else process.env.APPLAUD_CONFIG_DIR = original;
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates the directory if missing and returns its path", () => {
    const target = path.join(tmpRoot, "nested", "applaud");
    process.env.APPLAUD_CONFIG_DIR = target;
    expect(existsSync(target)).toBe(false);
    const result = ensureConfigDir();
    expect(result).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it("is idempotent when called twice", () => {
    const target = path.join(tmpRoot, "applaud");
    process.env.APPLAUD_CONFIG_DIR = target;
    ensureConfigDir();
    expect(() => ensureConfigDir()).not.toThrow();
    expect(existsSync(target)).toBe(true);
  });
});
