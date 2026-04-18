import { defineProject } from "vitest/config";
import { baseTestConfig } from "../vitest.shared.js";

export default defineProject({
  test: {
    ...baseTestConfig(),
    name: "shared",
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
