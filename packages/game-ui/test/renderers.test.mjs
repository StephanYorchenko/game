import { test, expect } from "@playwright/test";

test("Phaser меняет размер canvas при новом снимке без второго видимого рендера", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#map canvas")).toHaveAttribute("width", "738");
  await page.evaluate(async () => {
    const { createMapView } = await import("/src/map-view.ts");
    const view = createMapView(document.getElementById("map"));
    view.render({
      version: 1,
      map: {
        width: 1,
        height: 1,
        cells: [{ surface: "ground", area: "inside", structure: null }],
      },
      units: [],
      traps: [],
    });
  });
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#map canvas")).toHaveCount(1);
  await expect(page.locator("#map canvas")).toHaveAttribute("width", "75");
  await expect(page.locator("#map canvas")).toHaveAttribute("height", "75");
  await expect(page.locator("#map table")).toHaveCSS("opacity", "0");
  await expect(page.getByRole("table", { name: "Карта 1 × 1" })).toBeVisible();
});

test("адаптеры освобождают Phaser canvas и React root и допускают новый mount", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await page.evaluate(async () => {
    const { createMapView } = await import("/src/map-view.ts");
    const { createDemoWorld } = await import("/src/demo.ts");
    const { destroyCellInspector } = await import("/src/cell-inspector.tsx");
    const root = document.getElementById("map");
    const view = createMapView(root);
    view.render(createDemoWorld());
    view.destroy();
    destroyCellInspector(document.getElementById("cell-inspector"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator("#map canvas")).toHaveCount(0);
  await expect(page.locator("#cell-inspector")).toBeEmpty();
  await page.evaluate(async () => {
    const { createMapView } = await import("/src/map-view.ts");
    const { createDemoWorld } = await import("/src/demo.ts");
    const { renderCellInspector } = await import("/src/cell-inspector.tsx");
    createMapView(document.getElementById("map")).render(createDemoWorld());
    renderCellInspector(document.getElementById("cell-inspector"), null);
  });
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#map canvas")).toHaveCount(1);
  await expect(page.locator("#cell-inspector")).toContainText("Выберите клетку");
  expect(errors).toEqual([]);
});
