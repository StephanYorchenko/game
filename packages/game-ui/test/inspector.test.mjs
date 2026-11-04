import { test, expect } from "@playwright/test";

function button(page, x, y) {
  return page.locator(`td[data-x="${x}"][data-y="${y}"] button`);
}

function inspector(page) {
  return page.locator("#cell-inspector");
}

async function clickCell(page, x, y) {
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await page.locator("#map canvas").click({
    position: { x: 24 + x * 51 + 24, y: 24 + y * 51 + 24 },
  });
}

async function mountFixture(page) {
  await page.evaluate(async () => {
    const { createDemoWorld } = await import("/src/demo.ts");
    const { createMapView } = await import("/src/map-view.ts");
    const { renderCellInspector } = await import("/src/cell-inspector.tsx");
    const world = createDemoWorld();
    const view = createMapView(document.getElementById("map"), {
      onSelect: (selection) => renderCellInspector(
        document.getElementById("cell-inspector"),
        selection,
      ),
    });
    view.render(world);
    window.testMap = { world, view };
  });
}

test("клик показывает поверхность, структуру, укрепление, юнита и ловушку", async ({ page }) => {
  await page.goto("/");
  await clickCell(page, 5, 4);
  await expect(inspector(page)).toContainText("Клетка (5, 4)");
  await expect(inspector(page)).toContainText("Внутри здания");
  await expect(inspector(page)).toContainText("defender-1");
  await expect(inspector(page)).toContainText("demo-defender");
  await expect(inspector(page)).toContainText("8 / 10");

  for (const name of ["Сопротивление", "Сила", "Ловкость", "Урон", "Движение"]) {
    await expect(inspector(page).getByText(name, { exact: true })).toBeVisible();
  }

  await expect(button(page, 5, 4)).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: test.info().outputPath("inspector.png"), fullPage: true });
  await clickCell(page, 6, 7);
  await expect(inspector(page)).toContainText("Дверь");
  await expect(inspector(page)).toContainText("Закрыто");
  await expect(inspector(page)).toContainText("Укрепление");
  await expect(inspector(page)).toContainText("6 / 8");
  await expect(inspector(page)).toContainText("Клетка свободна");
  await expect(button(page, 5, 4)).toHaveAttribute("aria-pressed", "false");
  await clickCell(page, 6, 6);
  await expect(inspector(page)).toContainText("Ловушка");
  await expect(inspector(page)).toContainText("demo-trap");
  await clickCell(page, 0, 0);
  await expect(inspector(page)).toContainText("Грунт");
  await expect(inspector(page)).toContainText("Снаружи здания");
});

test("стрелки меняют фокус, Enter и пробел выбирают; Tab не обходит всю карту", async ({ page }) => {
  await page.goto("/");
  await button(page, 0, 0).focus();
  await button(page, 0, 0).press("ArrowLeft");
  await expect(button(page, 0, 0)).toBeFocused();
  await button(page, 0, 0).press("ArrowRight");
  await expect(button(page, 1, 0)).toBeFocused();
  await expect(inspector(page)).toContainText("Выберите клетку");
  await button(page, 1, 0).press("Enter");
  await expect(button(page, 1, 0)).toHaveAttribute("aria-pressed", "true");
  await button(page, 1, 0).press("ArrowDown");
  await expect(inspector(page)).toContainText("Клетка (1, 0)");
  await expect(button(page, 1, 1)).toHaveAttribute("aria-pressed", "false");
  await button(page, 1, 1).press("Space");
  await expect(inspector(page)).toContainText("Клетка (1, 1)");
  await expect(button(page, 1, 0)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#map button[tabindex='0']")).toHaveCount(1);
  await button(page, 1, 1).press("Tab");
  await expect(button(page, 1, 1)).not.toBeFocused();
  const focusInsideMap = await page.locator("#map").evaluate(
    (root) => root.contains(document.activeElement),
  );
  expect(focusInsideMap).toBe(false);
});

test("инспектор читает оба слоя проёма, новый HP и смерть из следующего снимка", async ({ page }) => {
  await page.goto("/");
  await mountFixture(page);
  await page.evaluate(() => {
    const { world, view } = window.testMap;
    world.units[0].position = { x: 3, y: 4 };
    world.units[0].stats.hp = 0;
    world.units[0].definitionId = "<img src=x onerror=alert(1)>";
    view.render(world);
  });
  await clickCell(page, 3, 4);
  await expect(inspector(page)).toContainText("Дверь");
  await expect(inspector(page)).toContainText("Открыто");
  await expect(inspector(page)).toContainText("defender-1");
  await expect(inspector(page)).toContainText("0 / 10");
  await expect(inspector(page)).toContainText("<img src=x onerror=alert(1)>");
  await expect(inspector(page).locator("img")).toHaveCount(0);
  await page.evaluate(() => {
    const next = structuredClone(window.testMap.world);
    next.units[0].stats.hp = 4;
    window.testMap.view.render(next);
  });
  await expect(inspector(page)).toContainText("4 / 10");
  await expect(button(page, 3, 4)).toHaveAttribute("aria-pressed", "true");
  await expect(button(page, 3, 4)).toBeFocused();
  await page.evaluate(() => {
    const next = structuredClone(window.testMap.world);
    next.units[0].alive = false;
    next.units[0].position = null;
    window.testMap.view.render(next);
  });
  await expect(inspector(page)).toContainText("Клетка свободна");
  await expect(inspector(page)).not.toContainText("defender-1");
  await expect(inspector(page)).toContainText("Дверь");
});

test("уменьшение карты сбрасывает исчезнувший выбор; destroy очищает инспектор", async ({ page }) => {
  await page.goto("/");
  await mountFixture(page);
  await clickCell(page, 8, 5);
  await page.evaluate(() => {
    const { world, view } = window.testMap;
    view.render({
      version: 1,
      map: { width: 1, height: 1, cells: [world.map.cells[0]] },
      units: [],
      traps: [],
    });
  });
  await expect(inspector(page)).toContainText("Выберите клетку");
  await expect(button(page, 0, 0)).toBeFocused();
  await expect(button(page, 0, 0)).toHaveAttribute("aria-pressed", "false");
  await button(page, 0, 0).press("Enter");
  await expect(inspector(page)).toContainText("Клетка (0, 0)");
  await page.evaluate(() => window.testMap.view.destroy());
  await expect(page.locator("#map table")).toHaveCount(0);
  await expect(inspector(page)).toContainText("Выберите клетку");
});

test("на телефоне длинный ID инспектора переносится внутри экрана", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await mountFixture(page);
  await page.evaluate(() => {
    const { world, view } = window.testMap;
    world.units[0].definitionId = "very-long-content-definition-id-".repeat(8);
    view.render(world);
  });
  await clickCell(page, 5, 4);
  await expect(inspector(page)).toContainText("defender-1");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: test.info().outputPath("inspector-mobile.png"), fullPage: true });
});
