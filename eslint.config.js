import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import testingLibrary from "eslint-plugin-testing-library";
import globals from "globals";

export default tseslint.config(
  // Global ignores must live in their own config object (only `ignores` key).
  // Mixing with other keys downgrades it to per-file and stops ignoring
  // directories — which is how built `dist/` bundles started getting linted.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "playwright-report/**",
      "test-results/**",
      "**/.vite/**",
      "**/.claude/**",
    ],
  },
  {
    // `no-console` isn't enabled here (console.log is a legitimate first-run
    // UX path in server/src/index.ts), so existing `eslint-disable-next-line
    // no-console` comments are harmless. Turning off the linter's noise about
    // them keeps the signal-to-noise ratio of `pnpm lint` high.
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
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
