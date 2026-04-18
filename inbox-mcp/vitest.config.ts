import { defineProject } from "vitest/config";
import { baseTestConfig } from "../vitest.shared.js";

export default defineProject({
  test: {
    ...baseTestConfig("inbox-mcp"),
    name: "inbox-mcp",
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    testTimeout: 10_000,
  },
});
