import { readFileSync } from "node:fs";
import { fixupPluginRules } from "@eslint/compat";
import { defineConfig } from "eslint/config";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import * as pluginEmotion from "@emotion/eslint-plugin";

const reactPlugin = fixupPluginRules(pluginReact);

const uiPackage = JSON.parse(
  readFileSync(new URL("../../packages/game-ui/package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  name: "workspace/react",
  files: ["**/*.{jsx,tsx}", "packages/game-ui/src/**/*.{js,ts}"],
  extends: [
    { ...pluginReact.configs.flat.recommended, plugins: { react: reactPlugin } },
    { ...pluginReact.configs.flat["jsx-runtime"], plugins: { react: reactPlugin } },
    pluginReactHooks.configs.flat.recommended,
  ],
  plugins: { "@emotion": fixupPluginRules(pluginEmotion) },
  settings: { react: { version: uiPackage.dependencies.react } },
  rules: {
    "react/boolean-prop-naming": [
      "warn",
      {
        rule: "^(disabled|readonly|required|show|(is|has|are|have|can|with|should)[A-Z]([A-Za-z0-9]?)+)",
      },
    ],
    "react/display-name": "off",
    "react/prop-types": "off",
    "react/jsx-curly-brace-presence": ["error", { children: "never", props: "never" }],
    "react/jsx-key": "warn",
    "react/jsx-uses-react": "error",
    "react/hook-use-state": ["warn", { allowDestructuredState: true }],
    "@emotion/syntax-preference": ["warn", "object"],
  },
});
