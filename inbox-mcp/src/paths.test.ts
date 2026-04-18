import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
