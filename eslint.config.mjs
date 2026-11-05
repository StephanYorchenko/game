import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import base from "./tooling/eslint/base.mjs";
import typescript from "./tooling/eslint/typescript.mjs";
import react from "./tooling/eslint/react.mjs";

const testFiles = [
  "**/*.test.{js,mjs,cjs,jsx,ts,tsx,mts,cts}",
  "**/test/**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}",
  "**/tests/**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}",
];

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/test-results/**",
    "**/playwright-report/**",
    "**/.pnpm-store/**",
  ]),
  base,
  typescript,
  react,
  {
    name: "workspace/test-generators",
    files: testFiles,
    // Тестовый обработчик может намеренно выдать ноль пакетов или бросить до первого yield.
    rules: { "require-yield": "off" },
  },
  {
    name: "workspace/node-tools-and-tests",
    files: [
      "eslint.config.mjs",
      "tooling/**/*.{js,mjs,cjs,ts,mts,cts}",
      "**/*.config.{js,mjs,cjs,ts}",
      ...testFiles,
      "**/example.{js,mjs,cjs}",
      "**/fixtures.mjs",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    name: "workspace/browser",
    files: [
      "packages/game-ui/src/**/*.{js,jsx,ts,tsx}",
      "**/*.{jsx,tsx}",
      "packages/game-ui/test/**",
    ],
    languageOptions: { globals: globals.browser },
  },
);
