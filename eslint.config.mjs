import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      ".artifacts/**",
      "dist/**",
      "public/**",
      "panda-docs/**",
      "src/shared/i18n/messages.d.ts",
      "src/shared/i18n/catalogs.js",
      "src/shared/i18n/server-catalogs.js",
    ],
  },
  js.configs.recommended,
  { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
  {
    files: ["src/**/*.{js,ts}", "scripts/**/*.{mjs,ts}", "tests/**/*.{mjs,ts}", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, Bun: "readonly", PANDA_LOCALE_VERSION: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-restricted-globals": ["error", "alert", "confirm", "prompt"],
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
  },
];
