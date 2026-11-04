import { test, expect } from "@playwright/test";
import { canEnterCell, getOccupant, loadWorld } from "@deathwarriors/game-core";
import { canReachMaskedCell, isInMask } from "@deathwarriors/game-core/geometry";

async function fixture(page) {
  const world = await page.evaluate(async () => {
    const { createDemoWorld } = await import("/src/demo.ts");
    const { createMapView } = await import("/src/map-view.ts");
    const { renderCellInspector } = await import("/src/cell-inspector.tsx");
    const { renderOverlayControls } = await import("/src/overlay-controls.tsx");
    const world = createDemoWorld();
    world.units[0].attackMask[2][4] = 1;
    world.map.cells[4 * world.map.width + 6].structure = { id: "line-wall", kind: "wall" };
    const view = createMapView(document.getElementById("map"), {
      onSelect: (selection) => renderCellInspector(
        document.getElementById("cell-inspector"),
        selection,
      ),
      onOverlayState: (state) => renderOverlayControls(
        document.getElementById("overlay-controls"),
        state,
        (mode) => view.setOverlay(mode),
      ),
    });
    view.render(world);
    window.overlayFixture = { world, view };
    return world;
  });
  return loadWorld(world);
}

async function clickCell(page, x, y) {
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await page.locator("#map canvas").click({
    position: { x: 24 + x * 51 + 24, y: 24 + y * 51 + 24 },
  });
}

async function annotations(page) {
  return page.locator("#map button[data-overlay]").evaluateAll((buttons) => buttons.map(
    (button) => ({
      x: Number(button.parentElement.dataset.x),
      y: Number(button.parentElement.dataset.y),
      kind: button.dataset.overlay,
    }),
  ));
}

test("маска и линия совпадают с core; слой реально появляется на canvas", async ({ page }) => {
  await page.goto("/");
  const world = await fixture(page);
  await expect(page.getByRole("radio", { name: "Маска атаки" })).toBeDisabled();
  await clickCell(page, 5, 4);
  const radio = page.getByRole("radio", { name: "Маска атаки" });
  await radio.focus();
  const before = await page.locator("#map canvas").screenshot();
  await radio.check();
  const expected = [];
  const unit = world.units[0];

  for (let y = 0; y < world.map.height; y++) {
    for (let x = 0; x < world.map.width; x++) {
      if (isInMask(unit.attackMask, unit.position, { x, y })) {
        expected.push({
          x,
          y,
          kind: canReachMaskedCell(world, unit.position, { x, y }, unit.attackMask)
            ? "attack-clear"
            : "attack-blocked",
        });
      }
    }
  }

  expect(await annotations(page)).toEqual(expected);
  await expect(page.locator('td[data-x="7"][data-y="4"]')).toHaveAccessibleName(
    /линия перекрыта/,
  );
  await expect(async () => {
    const after = await page.locator("#map canvas").screenshot();
    expect(after.equals(before)).toBe(false);
  }).toPass();
  await page.screenshot({ path: test.info().outputPath("attack-overlay.png"), fullPage: true });
});

test("проходимость и занятость используют core, включая ловушки и область здания", async ({ page }) => {
  await page.goto("/");
  const world = await fixture(page);
  await clickCell(page, 5, 4);
  await page.getByRole("radio", { name: "Проходимость", exact: true }).check();
  const unit = world.units[0];
  const expected = [];

  for (let y = 0; y < world.map.height; y++) {
    for (let x = 0; x < world.map.width; x++) {
      const open = canEnterCell(world, unit, { x, y });
      const occupied = getOccupant(world, { x, y });
      expected.push({
        x,
        y,
        kind: open ? "move-open" : occupied ? "move-occupied" : "move-blocked",
      });
    }
  }

  expect(await annotations(page)).toEqual(expected);
  await clickCell(page, 1, 6);
  await expect(page.getByRole("radio", { name: "Проходимость", exact: true })).toBeChecked();
  await expect(page.locator('td[data-x="6"][data-y="6"]')).toHaveAccessibleName(
    /клетка доступна; есть ловушка/,
  );
  await page.getByRole("radio", { name: "Без слоя" }).check();
  expect(await annotations(page)).toEqual([]);
});

test("новый снимок пересчитывает линию; потеря выбранного юнита очищает слой", async ({ page }) => {
  await page.goto("/");
  await fixture(page);
  await clickCell(page, 5, 4);
  await page.getByRole("radio", { name: "Маска атаки" }).check();
  await expect(page.locator('td[data-x="7"][data-y="4"] button')).toHaveAttribute(
    "data-overlay", "attack-blocked",
  );
  await page.evaluate(() => {
    const next = structuredClone(window.overlayFixture.world);
    next.map.cells[4 * next.map.width + 6].structure = null;
    window.overlayFixture.view.render(next);
  });
  await expect(page.locator('td[data-x="7"][data-y="4"] button')).toHaveAttribute(
    "data-overlay", "attack-clear",
  );
  await page.evaluate(() => {
    const next = structuredClone(window.overlayFixture.world);
    next.units[0].alive = false;
    next.units[0].stats.hp = 0;
    next.units[0].position = null;
    window.overlayFixture.view.render(next);
  });
  await expect(page.getByRole("radio", { name: "Маска атаки" })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Без слоя" })).toBeChecked();
  expect(await annotations(page)).toEqual([]);
  await expect(page.locator('td[data-x="7"][data-y="4"]')).not.toHaveAccessibleName(
    /Маска атаки/,
  );
});

test("слой выключается для клетки без юнита и доступен с клавиатуры на телефоне", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await clickCell(page, 5, 4);
  const radio = page.getByRole("radio", { name: "Маска атаки" });
  await radio.focus();
  await radio.press("Space");
  await expect(radio).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("overlay-mobile.png"), fullPage: true });
  await clickCell(page, 6, 6);
  await expect(radio).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Без слоя" })).toBeChecked();
  expect(await annotations(page)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
