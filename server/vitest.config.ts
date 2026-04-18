import { defineProject } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseTestConfig } from "../vitest.shared.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Alias @rootscribe/shared to its source so tests see in-progress edits without
// waiting for `pnpm -C shared build`. Production imports (and `pnpm build`)
// still go through the compiled ./dist output — the alias only applies under
// Vitest.
const sharedSrc = path.resolve(here, "..", "shared", "src", "index.ts");

export default defineProject({
  resolve: {
    alias: {
      "@rootscribe/shared": sharedSrc,
    },
  },
  test: {
    ...baseTestConfig("server"),
    name: "server",
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 10_000,
    // Several server suites mutate `process.env.ROOTSCRIBE_CONFIG_DIR` at
    // module load (src/paths.test.ts, tests/routes/config.test.ts) and
    // rely on it staying put for the duration of the file. With Vitest's
    // default parallel execution, two files could overwrite each other's
    // env between imports and module initialization — serializing files
    // keeps the env deterministic. `describe` blocks within a file still
    // run sequentially by default, so no per-test slowdown.
    fileParallelism: false,
  },
});
