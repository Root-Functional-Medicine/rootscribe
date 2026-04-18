import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import testingLibrary from "eslint-plugin-testing-library";
import globals from "globals";

export default tseslint.config(
  {
    // `no-console` isn't enabled here (console.log is a legitimate first-run
    // UX path in server/src/index.ts), so existing `eslint-disable-next-line
    // no-console` comments are harmless. Turning off the linter's noise about
    // them keeps the signal-to-noise ratio of `pnpm lint` high.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    ignores: [
      "dist/",
      "**/dist/",
      "node_modules/",
      "**/node_modules/",
      "coverage/",
      "**/coverage/",
      "playwright-report/",
      "test-results/",
      ".vite/",
      "**/.vite/",
      ".claude/",
      "**/.claude/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx,js,jsx}", "**/tests/**/*.{ts,tsx}"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/expect-expect": "error",
      "vitest/no-disabled-tests": "warn",
      "vitest/no-focused-tests": "error",
      "vitest/no-identical-title": "error",
    },
  },
  {
    files: ["web/**/*.{test,spec}.{ts,tsx}"],
    plugins: { "testing-library": testingLibrary },
    rules: {
      ...testingLibrary.configs.react.rules,
    },
  },
);
