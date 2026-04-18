import { defineProject } from "vitest/config";
import { baseTestConfig } from "../vitest.shared.js";

export default defineProject({
  test: {
    ...baseTestConfig("inbox-mcp"),
    name: "inbox-mcp",
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    testTimeout: 10_000,
    // inbox-mcp tests mutate `process.env.ROOTSCRIBE_CONFIG_DIR` at module
    // load (tests/db.test.ts, src/paths.test.ts) and cache a DB
    // connection against that path. Running files in parallel would let
    // one file's env override another's before the db module initializes.
    // Serializing files keeps each suite's path resolution deterministic.
    fileParallelism: false,
  },
});
