import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("публичная точка входа собранного пакета загружается без браузера", async () => {
  await import("@deathwarriors/game-core");
});

test("публичные декларации типов подключаются потребителем NodeNext без bundler", async () => {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const entries = Object.entries(manifest.exports);
  const paths = {};
  const imports = [];

  for (const [index, [subpath, entry]] of entries.entries()) {
    const name = manifest.name + (subpath === "." ? "" : subpath.slice(1));
    paths[name] = [resolve(packageRoot, entry.types)];
    imports.push(`import * as Entry${index} from "${name}";`);
  }

  const directory = await mkdtemp(join(tmpdir(), "deathwarriors-node-next-"));

  try {
    await writeFile(join(directory, "consumer.mts"), imports.join("\n") + "\n");
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          types: [],
          paths,
        },
        files: ["consumer.mts"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(packageRoot, "node_modules/typescript/bin/tsc"),
        "--project",
        join(directory, "tsconfig.json"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30000 },
    );

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
