import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "./shared/vitest.config.ts",
  "./server/vitest.config.ts",
  "./web/vitest.config.ts",
  "./inbox-mcp/vitest.config.ts",
]);
