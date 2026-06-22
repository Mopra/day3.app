import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist",
      ".next",
      ".wrangler",
      "node_modules",
      "worker-configuration.d.ts",
      "migrations",
      ".claude",
      // Hand-written static browser scripts served as-is (own IIFE, browser
      // globals) — not part of the TS source graph.
      "public/**/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: [
      "app/**/*.{ts,tsx}",
      "src/app/**/*.{ts,tsx}",
      "src/components/**/*.tsx",
      "src/hooks/**/*.ts",
    ],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Plain fetch-then-setState loading (no data library) is deliberate here.
      "react-hooks/set-state-in-effect": "off",
    },
  },
);
