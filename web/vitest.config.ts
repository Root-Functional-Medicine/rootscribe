import { defineProject } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseTestConfig } from "../vitest.shared.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.resolve(here, "..", "shared", "src", "index.ts");
const sharedTestFactories = path.resolve(
  here,
  "..",
  "shared",
  "src",
  "test-factories",
  "index.ts",
);

export default defineProject({
  plugins: [react()],
  resolve: {
    // Array form (not object) so the more specific subpath alias is tried
    // before the bare-package alias — otherwise the `@rootscribe/shared`
    // prefix swallows `@rootscribe/shared/test-factories` and Vite can't
    // find the file.
    alias: [
      {
        find: "@rootscribe/shared/test-factories",
        replacement: sharedTestFactories,
      },
      { find: "@rootscribe/shared", replacement: sharedSrc },
    ],
  },
  test: {
    ...baseTestConfig("web"),
    name: "web",
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
  },
});
