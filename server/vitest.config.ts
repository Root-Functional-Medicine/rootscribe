import { defineProject } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseTestConfig } from "../vitest.shared.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Alias @applaud/shared to its source so tests see in-progress edits without
// waiting for `pnpm -C shared build`. Production imports (and `pnpm build`)
// still go through the compiled ./dist output — the alias only applies under
// Vitest.
const sharedSrc = path.resolve(here, "..", "shared", "src", "index.ts");

export default defineProject({
  resolve: {
    alias: {
      "@applaud/shared": sharedSrc,
    },
  },
  test: {
    ...baseTestConfig("server"),
    name: "server",
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 10_000,
  },
});
