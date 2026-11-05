import js from "@eslint/js";
import { fixupPluginRules } from "@eslint/compat";
import { defineConfig } from "eslint/config";
import pluginImport from "eslint-plugin-import";
import pluginPromise from "eslint-plugin-promise";
import globals from "globals";
import { fileURLToPath } from "node:url";

export const importPlugin = fixupPluginRules(pluginImport);

export const codeFiles = ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}"];

export default defineConfig({
  name: "workspace/base",
  files: codeFiles,
  extends: [
    js.configs.recommended,
    pluginPromise.configs["flat/recommended"],
    {
      ...pluginImport.flatConfigs.recommended,
      plugins: { import: importPlugin },
    },
  ],
  languageOptions: {
    ecmaVersion: "latest",
    globals: globals.es2022,
  },
  settings: {
    "import/parsers": { "@typescript-eslint/parser": [".ts", ".tsx", ".mts", ".cts"] },
    "import/resolver": {
      typescript: {
        project: fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
        alwaysTryTypes: true,
      },
      node: { extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"] },
    },
  },
  rules: {
    "consistent-return": "off",
    "no-duplicate-imports": "warn",
    "no-unused-vars": [
      "warn",
      {
        args: "all",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ],
    "no-useless-escape": "warn",
    "no-nested-ternary": "warn",
    "promise/catch-or-return": "warn",
    "promise/always-return": "warn",
    quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
    curly: ["error", "all"],
    "brace-style": ["error", "1tbs", { allowSingleLine: false }],
  },
});
