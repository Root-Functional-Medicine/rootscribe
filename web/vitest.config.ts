import { defineProject } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseTestConfig } from "../vitest.shared.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.resolve(here, "..", "shared", "src", "index.ts");

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: {
      "@applaud/shared": sharedSrc,
    },
  },
  test: {
    ...baseTestConfig(),
    name: "web",
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
  },
});
