import { test, expect } from "@playwright/test";

function cell(page, x, y) {
  return page.locator(`td[data-x="${x}"][data-y="${y}"]`);
}

test("рендерит сценарий core, поверхности, структуры и сущности", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("table", { name: "Карта 14 × 10" })).toBeVisible();
  await expect(page.locator("td[data-x]")).toHaveCount(140);
  await expect(page.getByRole("status")).toHaveText(
    "Защитники: 2 · Противники: 3 · Ловушки: 1",
  );
  await expect(cell(page, 0, 0)).toHaveAccessibleName(/Грунт; Снаружи здания/);
  await expect(cell(page, 4, 3)).toHaveAccessibleName(/Пол; Внутри здания/);
  await expect(cell(page, 3, 2)).toHaveAccessibleName(/Стена/);
  await expect(cell(page, 7, 4)).toHaveAccessibleName(/Препятствие/);
  await expect(cell(page, 6, 6)).toHaveAccessibleName(/Ловушка: trap-1/);
  await expect(page.locator(".tile .defender")).toHaveCount(2);
  await expect(page.locator(".tile .enemy")).toHaveCount(3);

  for (const state of ["open", "closed", "destroyed"]) {
    for (const kind of ["door", "window"]) {
      await expect(page.locator(`[data-structure="${kind}"][data-state="${state}"]`))
        .toHaveCount(1);
    }
  }

  await expect(cell(page, 6, 7)).toHaveAccessibleName(/укрепление 6\/8/);
  expect(errors).toEqual([]);
});

test("новый снимок перемещает юнита, освобождает клетку и сохраняет проём", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createDemoWorld } = await import("/src/demo.ts");
    const { createMapView } = await import("/src/map-view.ts");
    const world = createDemoWorld();
    const before = JSON.stringify(world);
    const root = document.getElementById("map");
    const view = createMapView(root);
    view.render(world);
    const unchanged = before === JSON.stringify(world);
    const next = structuredClone(world);
    next.units[0].position = { x: 3, y: 4 };
    next.units[0].stats.hp = 3;
    next.units[1].alive = false;
    next.units[1].position = null;
    next.units[1].stats.hp = 0;
    view.render(next);
    return { unchanged, originalUnchanged: before === JSON.stringify(world) };
  });
  expect(result).toEqual({ unchanged: true, originalUnchanged: true });
  await expect(cell(page, 5, 4).locator(".token")).toHaveCount(0);
  await expect(cell(page, 8, 5).locator(".token")).toHaveCount(0);
  await expect(cell(page, 3, 4)).toHaveAccessibleName(/Дверь.*открыто.*Защитник.*HP 3\/10/);
  await expect(cell(page, 3, 4).locator(".opening")).toBeVisible();
  await expect(cell(page, 3, 4).locator(".token")).toBeVisible();
});

test("размер нового снимка заменяет сетку; ID выводится безопасным текстом", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { createDemoWorld } = await import("/src/demo.ts");
    const { createMapView } = await import("/src/map-view.ts");
    const world = createDemoWorld();
    world.units = [];
    world.traps = [];
    world.map = {
      width: 1, height: 1,
      cells: [{ surface: "ground", area: "inside", structure: {
        id: "<img src=x onerror=alert(1)>", kind: "wall",
      } }],
    };
    createMapView(document.getElementById("map")).render(world);
  });
  await expect(page.getByRole("table", { name: "Карта 1 × 1" })).toBeVisible();
  await expect(page.locator("td[data-x]")).toHaveCount(1);
  await expect(cell(page, 0, 0)).toHaveAccessibleName(/<img src=x onerror=alert\(1\)>/);
  await expect(page.locator("#map img")).toHaveCount(0);
  await expect(cell(page, 0, 0).locator(".tile")).toHaveClass(/ground inside/);
});

test("на узком экране прокручивается карта, страница помещается в экран", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Читать карту" })).toBeVisible();
  const region = page.getByRole("region", { name: "Карта с прокруткой" });
  await region.focus();
  await expect(region).toBeFocused();
  const sizes = await region.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport);
  await page.screenshot({ path: test.info().outputPath("map-mobile.png"), fullPage: true });
});
