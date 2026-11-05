import { defineConfig } from "eslint/config";
import pluginImport from "eslint-plugin-import";
import { configs } from "typescript-eslint";
import { importPlugin } from "./base.mjs";

export default defineConfig({
  name: "workspace/typescript",
  files: ["**/*.{ts,tsx,mts,cts}"],
  extends: [
    configs.recommended,
    { ...pluginImport.flatConfigs.typescript, plugins: { import: importPlugin } },
  ],
  rules: {
    "no-duplicate-imports": ["warn", { allowSeparateTypeImports: true }],
    "@typescript-eslint/ban-ts-comment": "warn",
    "@typescript-eslint/naming-convention": [
      "warn",
      {
        selector: "default",
        format: ["camelCase"],
        leadingUnderscore: "allow",
        trailingUnderscore: "allow",
      },
      { selector: "import", format: ["camelCase", "PascalCase"] },
      { selector: "typeLike", format: ["PascalCase"] },
      { selector: "typeProperty", format: ["camelCase", "snake_case"] },
      { selector: "enum", format: ["PascalCase"] },
      { selector: "enumMember", format: ["UPPER_CASE"] },
      { selector: "objectLiteralProperty", format: null },
      { selector: "function", format: ["camelCase", "PascalCase"] },
      { selector: "variable", format: ["camelCase", "PascalCase", "UPPER_CASE"] },
    ],
    "@typescript-eslint/no-empty-interface": "warn",
    "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "always" }],
    "no-redeclare": "off",
    "@typescript-eslint/no-redeclare": "error",
    "no-empty-function": "off",
    "@typescript-eslint/no-empty-function": "warn",
    "@typescript-eslint/no-inferrable-types": "warn",
    "no-use-before-define": "off",
    "@typescript-eslint/no-use-before-define": ["warn", { functions: false }],
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        args: "all",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ],
    "@typescript-eslint/no-unused-expressions": "off",
    "@typescript-eslint/no-explicit-any": "warn",
  },
});
