import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { configDir, dbPath } from "./paths.js";

describe("configDir", () => {
  const original = process.env.APPLAUD_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.APPLAUD_CONFIG_DIR;
  });

  afterEach(() => {
    if (original == null) delete process.env.APPLAUD_CONFIG_DIR;
    else process.env.APPLAUD_CONFIG_DIR = original;
  });

  it("returns APPLAUD_CONFIG_DIR when set", () => {
    process.env.APPLAUD_CONFIG_DIR = "/tmp/applaud-override";
    expect(configDir()).toBe("/tmp/applaud-override");
  });

  it("ignores an empty APPLAUD_CONFIG_DIR and falls back to platform default", () => {
    process.env.APPLAUD_CONFIG_DIR = "";
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
  const original = process.env.APPLAUD_CONFIG_DIR;

  afterEach(() => {
    if (original == null) delete process.env.APPLAUD_CONFIG_DIR;
    else process.env.APPLAUD_CONFIG_DIR = original;
  });

  it("is state.sqlite inside the configured directory", () => {
    process.env.APPLAUD_CONFIG_DIR = "/tmp/applaud-override";
    expect(dbPath()).toBe(path.join("/tmp/applaud-override", "state.sqlite"));
  });
});
