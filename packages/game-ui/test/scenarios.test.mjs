import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { parseWorld, serializeWorld } from "@deathwarriors/game-core";

function scenario() {
  return {
    version: 1,
    map: {
      width: 2,
      height: 2,
      cells: Array.from({ length: 4 }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units: [],
    traps: [{
      id: "imported-trap",
      kind: "trap",
      definitionId: "imported-definition",
      position: { x: 1, y: 1 },
    }],
  };
}

async function upload(page, content, name = "scenario.json") {
  await page.getByLabel("Открыть JSON").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(content),
  });
}

async function exportWorld(page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("deathwarriors-scenario.json");
  return parseWorld(await readFile(await download.path(), "utf8"));
}

test("локальный JSON заменяет карту и экспортируется через core без потери данных", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("table")).toBeVisible();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  const world = scenario();
  await upload(page, serializeWorld(world));
  await expect(page.getByRole("table", { name: "Карта 2 × 2" })).toBeVisible();
  await expect(page.locator("#scenario-name")).toHaveText("scenario.json");
  await expect(page.getByRole("status")).toHaveText(
    "Защитники: 0 · Противники: 0 · Ловушки: 1",
  );
  await expect(page.locator("[data-occupant='imported-trap']")).toBeVisible();
  expect(await exportWorld(page)).toEqual(world);
  expect(requests).toEqual([]);
});

test("ошибки JSON и схемы сохраняют последнюю карту, заголовок и экспорт", async ({ page }) => {
  await page.goto("/");
  const world = scenario();
  await upload(page, serializeWorld(world), "accepted.json");
  await expect(page.locator("#scenario-name")).toHaveText("accepted.json");
  await upload(page, "{", "broken.json");
  await expect(page.getByRole("alert")).toContainText("$: некорректный JSON");
  const invalid = scenario();
  invalid.map.width = 0;
  await upload(page, JSON.stringify(invalid));
  await expect(page.getByRole("alert")).toContainText("$.map.width");
  await expect(page.getByRole("table", { name: "Карта 2 × 2" })).toBeVisible();
  await expect(page.locator("#scenario-name")).toHaveText("accepted.json");
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await page.locator("#map canvas").click({ position: { x: 99, y: 99 } });
  await expect(page.locator("#cell-inspector")).toContainText("imported-trap");
  expect(await exportWorld(page)).toEqual(world);
  await page.getByRole("button", { name: "Вернуть демо" }).click();
  await expect(page.getByRole("table", { name: "Карта 14 × 10" })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Защитники: 2");
  const demo = await exportWorld(page);
  expect(demo.map.width).toBe(14);
  expect(demo.units).toHaveLength(5);
});

test("один файл можно выбрать повторно; имя и ошибка выводятся безопасным текстом", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const name = "<img src=x onerror=alert(1)>" + "long-name-".repeat(12) + ".json";
  await upload(page, serializeWorld(scenario()), name);
  await expect(page.locator("#scenario-name")).toHaveText(name);
  await expect(page.getByLabel("Открыть JSON")).toHaveValue("");
  await page.getByRole("button", { name: "Вернуть демо" }).click();
  await upload(page, serializeWorld(scenario()), name);
  await expect(page.locator("#scenario-name")).toHaveText(name);
  const invalid = { ...scenario(), "<img src=x onerror=alert(1)>": true };
  await upload(page, JSON.stringify(invalid));
  await expect(page.getByRole("alert")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator(".shell img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath("scenario-mobile.png"), fullPage: true });
});

test("позднее чтение файла не отменяет выбор нового сценария или сброс к демо", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const original = File.prototype.text;
    window.pendingReads = [];
    File.prototype.text = function () {
      if (this.name.startsWith("slow")) {
        return new Promise((resolve) => {
          window.pendingReads.push(() => original.call(this).then(resolve));
        });
      }

      return original.call(this);
    };
  });
  await upload(page, serializeWorld(scenario()), "slow-first.json");
  await upload(page, serializeWorld(scenario()), "latest.json");
  await expect(page.locator("#scenario-name")).toHaveText("latest.json");
  await page.evaluate(async () => {
    await window.pendingReads.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await expect(page.locator("#scenario-name")).toHaveText("latest.json");
  await upload(page, "{", "slow-invalid.json");
  await page.getByRole("button", { name: "Вернуть демо" }).click();
  await page.evaluate(async () => {
    await window.pendingReads.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await expect(page.getByRole("table", { name: "Карта 14 × 10" })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("ошибка чтения файла оставляет рабочую карту", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    File.prototype.text = () => Promise.reject(new Error("disk read failed"));
  });
  await upload(page, serializeWorld(scenario()));
  await expect(page.getByRole("alert")).toContainText("Не удалось прочитать файл");
  await expect(page.getByRole("table", { name: "Карта 14 × 10" })).toBeVisible();
  await expect(page.locator("#scenario-name")).toHaveText("Дом у опушки");
});
