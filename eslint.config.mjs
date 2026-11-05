import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import base from "./tooling/eslint/base.mjs";
import typescript from "./tooling/eslint/typescript.mjs";
import react from "./tooling/eslint/react.mjs";

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
    name: "workspace/node-tools-and-tests",
    files: [
      "eslint.config.mjs",
      "tooling/**/*.{js,mjs,cjs,ts,mts,cts}",
      "**/*.config.{js,mjs,cjs,ts}",
      "**/*.test.{js,mjs,cjs,ts}",
      "**/test/**/*.{js,mjs,cjs,ts}",
      "**/tests/**/*.{js,mjs,cjs,ts}",
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
