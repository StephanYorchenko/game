import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd });

async function messages(source, filePath) {
  const [result] = await eslint.lintText(source, { filePath });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return result.messages;
}

for (const file of [
  "packages/game-core/src/lint-probe.ts",
  "packages/new-module/src/lint-probe.ts",
]) {
  test("общие и TypeScript-правила работают без конфига пакета: " + file, async () => {
    const result = await messages("export const value: any = 'text';", file);
    assert(result.some((entry) => entry.ruleId === "quotes" && entry.severity === 2));
    assert(
      result.some(
        (entry) => entry.ruleId === "@typescript-eslint/no-explicit-any" && entry.severity === 1,
      ),
    );
  });
}

test("обычный JS получает recommended, promise и правила неиспользуемых переменных", async () => {
  const result = await messages(
    "const unused = 1; missing(); Promise.resolve(1).then((value) => { console.log(value); });",
    "tooling/lint-probe.mjs",
  );
  assert(result.some((entry) => entry.ruleId === "no-undef" && entry.severity === 2));
  assert(result.some((entry) => entry.ruleId === "no-unused-vars" && entry.severity === 1));
  assert(result.some((entry) => entry.ruleId === "promise/always-return" && entry.severity === 1));
});

test("Node и браузерные глобальные имена ограничены своими окружениями", async () => {
  const node = await messages("export const value = process.version;", "tooling/lint-probe.mjs");
  assert.deepEqual(node, []);
  const browser = await messages(
    "export const title = document.title;",
    "packages/game-ui/src/lint-probe.js",
  );
  assert.deepEqual(browser, []);
  const core = await messages(
    "export const value = process.version;",
    "packages/new-module/src/lint-probe.js",
  );
  assert(core.some((entry) => entry.ruleId === "no-undef"));
});

test("React, hooks и Emotion работают на TSX в новом workspace-пакете", async () => {
  const result = await messages(
    [
      'import { useState } from "react";',
      'import { css } from "@emotion/react";',
      "export const style = css" +
        String.fromCharCode(96) +
        "color: red;" +
        String.fromCharCode(96) +
        ";",
      "export function Sample({ active }: { active: boolean }) {",
      "  if (active) { useState(0); }",
      '  return <span title={"text"}>{"child"}</span>;',
      "}",
    ].join("\n"),
    "packages/new-module/src/lint-probe.tsx",
  );
  assert(
    result.some((entry) => entry.ruleId === "react-hooks/rules-of-hooks" && entry.severity === 2),
  );
  assert(
    result.some(
      (entry) => entry.ruleId === "react/jsx-curly-brace-presence" && entry.severity === 2,
    ),
  );
  assert(
    result.some((entry) => entry.ruleId === "@emotion/syntax-preference" && entry.severity === 1),
  );
});

test("короткие TS-импорты и API workspace разрешаются по исходникам", async () => {
  const result = await messages(
    [
      'import type { WorldState } from "@deathwarriors/game-core";',
      'import { createSimulation } from "@deathwarriors/game-core/simulation";',
      'import { createDemoWorld } from "./demo";',
      "export { createSimulation, createDemoWorld };",
      "export type { WorldState };",
    ].join("\n"),
    "packages/game-ui/src/lint-probe.ts",
  );
  assert.deepEqual(result, []);
  const broken = await messages(
    'export { missing } from "./missing-module";',
    "packages/game-ui/src/lint-probe.ts",
  );
  assert(broken.some((entry) => entry.ruleId === "import/no-unresolved"));
});

test("browser URL в Playwright проверяется как исходник Vite, а не игнорируется", async () => {
  const valid = await messages(
    'export async function load() {\n  return import("/src/demo.ts");\n}',
    "packages/game-ui/test/lint-probe.test.mjs",
  );
  assert.deepEqual(valid, []);
  const broken = await messages(
    'export async function load() {\n  return import("/src/missing-module.ts");\n}',
    "packages/game-ui/test/lint-probe.test.mjs",
  );
  assert(broken.some((entry) => entry.ruleId === "import/no-unresolved"));
});

test("артефакты сборки, отчёты и node_modules не проверяются", async () => {
  for (const file of [
    "packages/game-core/dist/index.js",
    "packages/game-ui/dist/main.js",
    "packages/new-module/dist/index.js",
    "coverage/example.js",
    "test-results/example.js",
    "playwright-report/example.js",
    "node_modules/example.js",
  ]) {
    assert.equal(await eslint.isPathIgnored(file), true, file);
  }
});
