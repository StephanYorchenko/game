import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { createSimulation } from "@deathwarriors/game-core/simulation";
import { parseWorld } from "@deathwarriors/game-core";

const demo = JSON.parse(await readFile(new URL("../src/night-demo.json", import.meta.url), "utf8"));

async function upload(page, input, name = "night.json") {
  await page.getByLabel("Загрузить JSON ночи").setInputFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(typeof input === "string" ? input : JSON.stringify(input)),
  });
}

async function exportWorld(page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать JSON", exact: true }).click();
  const file = await pending;
  return parseWorld(await readFile(await file.path(), "utf8"));
}

async function journal(page) {
  const entries = [];
  const journal = page.locator(".night-journal");

  if ((await journal.getAttribute("open")) === null) {
    await journal.locator(":scope > summary").click();
  }

  for (;;) {
    const texts = await page.locator(".event-list pre").allTextContents();
    entries.unshift(...texts.map((text) => JSON.parse(text)));
    const earlier = page.getByRole("button", { name: "Раньше", exact: true });

    if (!(await earlier.isEnabled())) {
      break;
    }

    await earlier.click();
  }

  return entries;
}

test("шаги обновляют карту, инспектор и журнал точно по API core; сброс воспроизводит ночь",
  async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Шаг", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Демо ночи", exact: true }).click();
    const session = createSimulation(demo);
    await expect(page.getByTestId("event-count")).toHaveText(String(session.getEvents().length));
    await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
    await page.locator("#map canvas").click({ position: { x: 354, y: 48 } });
    await expect(page.locator("#cell-inspector")).toContainText("wolf");

    for (let turn = 0; turn < 2; turn++) {
      const expected = session.step().snapshot;
      await page.getByRole("button", { name: "Шаг", exact: true }).click();
      await expect(page.getByTestId("night-turns")).toHaveText(String(expected.turnsTaken));
      await expect(page.getByTestId("night-round")).toHaveText(String(expected.round));
      await expect(page.getByTestId("night-next")).toHaveText(expected.nextUnitId ?? "—");
      expect(await exportWorld(page)).toEqual(expected.world);
    }

    await expect(page.locator("#cell-inspector")).not.toContainText("wolf");
    expect(await journal(page)).toEqual(session.getEvents());
    await page.getByRole("button", { name: "Сброс ночи", exact: true }).click();
    const reset = session.reset();
    await expect(page.getByTestId("night-turns")).toHaveText("0");
    expect(await exportWorld(page)).toEqual(reset.snapshot.world);
    expect(await journal(page)).toEqual(reset.events);
    await page.getByRole("button", { name: "Шаг", exact: true }).click();
    expect(await exportWorld(page)).toEqual(session.step().snapshot.world);
  });

test("пуск и пауза сохраняют события; завершение блокирует управление и совпадает с runToEnd",
  async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await page.getByRole("button", { name: "Демо ночи", exact: true }).click();
    await page.getByRole("button", { name: "Пуск", exact: true }).click();
    await page.clock.runFor(350);
    await expect(page.getByTestId("night-turns")).toHaveText("1");
    await page.getByRole("button", { name: "Пауза", exact: true }).click();
    const count = await page.getByTestId("event-count").textContent();
    await page.clock.runFor(2000);
    await expect(page.getByTestId("night-turns")).toHaveText("1");
    await expect(page.getByTestId("event-count")).toHaveText(count);
    await page.getByRole("button", { name: "Пуск", exact: true }).click();
    await page.clock.runFor(11000);
    const session = createSimulation(demo);
    const expected = session.runToEnd().snapshot;
    await expect(page.locator(".night-status")).toHaveAttribute("data-status", expected.status);
    await expect(page.getByTestId("night-turns")).toHaveText(String(expected.turnsTaken));
    await expect(page.getByRole("button", { name: "Шаг", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Пуск", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeDisabled();
    expect(await exportWorld(page)).toEqual(expected.world);
    expect(await journal(page)).toEqual(session.getEvents());
    await page.screenshot({ path: test.info().outputPath("night-completed.png"), fullPage: true });
  });

test("поражение приходит из core, reset снимает терминальное состояние", async ({ page }) => {
  const input = structuredClone(demo);
  input.content.effects.push({
    definitionId: "mortal",
    phase: "TURN_START",
    state: {},
    operations: [{ kind: "modify_hp", target: { kind: "owner" }, delta: -100 }],
  });
  input.content.units.find((unit) => unit.definitionId === "archer").effectIds = ["mortal"];
  await page.goto("/");
  await upload(page, input);
  const session = createSimulation(input);

  while (session.getSnapshot().status === "running") {
    session.step();
    await page.getByRole("button", { name: "Шаг", exact: true }).click();
  }

  expect(session.getSnapshot().status).toBe("defeat");
  await expect(page.locator(".night-status")).toContainText("Поражение");
  await expect(page.getByRole("button", { name: "Шаг", exact: true })).toBeDisabled();
  expect(await exportWorld(page)).toEqual(session.getSnapshot().world);
  await page.getByRole("button", { name: "Сброс ночи", exact: true }).click();
  await expect(page.getByRole("button", { name: "Шаг", exact: true })).toBeEnabled();
});

test("ошибки полного JSON сохраняют принятую ночь; обычный сценарий отменяет пуск",
  async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    await upload(page, demo);
    const initialEvents = String(createSimulation(demo).getEvents().length);
    await expect(page.getByTestId("event-count")).toHaveText(initialEvents);
    await upload(page, "{");
    await expect(page.locator("#night-controls [role=alert]")).toBeVisible();
    await upload(page, { ...demo, seed: -1 });
    await expect(page.locator("#night-controls [role=alert]")).toContainText("$.seed");
    expect(await exportWorld(page)).toEqual(demo.scenario.world);
    await expect(page.getByTestId("event-count")).toHaveText(initialEvents);
    await page.getByRole("button", { name: "Пуск", exact: true }).click();
    await page.getByLabel("Открыть JSON", { exact: true }).setInputFiles({
      name: "world.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(demo.scenario.world)),
    });
    await expect(page.locator("#scenario-name")).toHaveText("world.json");
    await page.clock.runFor(2000);
    await expect(page.locator(".night-status")).toHaveAttribute("data-status", "idle");
    await expect(page.getByTestId("event-count")).toHaveText("0");
    expect(await exportWorld(page)).toEqual(demo.scenario.world);
    await page.getByRole("button", { name: "Вернуть демо", exact: true }).click();
    await page.clock.runFor(2000);
    await expect(page.locator("#scenario-name")).toHaveText("Дом у опушки");
    await expect(page.locator(".night-status")).toHaveAttribute("data-status", "idle");
    await expect(page.getByTestId("event-count")).toHaveText("0");
    expect((await exportWorld(page)).map.width).toBe(14);
  });

test("запоздалый JSON ночи не заменяет новое демо или обычный сценарий", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const original = File.prototype.text;
    window.pendingNightReads = [];
    File.prototype.text = function () {
      if (this.name.startsWith("slow")) {
        return new Promise((resolve) => {
          window.pendingNightReads.push(() => original.call(this).then(resolve));
        });
      }

      return original.call(this);
    };
  });
  await upload(page, { ...demo, seed: 1 }, "slow-first.json");
  await page.getByRole("button", { name: "Демо ночи", exact: true }).click();
  await page.evaluate(() => window.pendingNightReads.shift()());
  await expect(page.locator("#scenario-name")).toHaveText("Демо ночи · дверь и ловушка");
  await upload(page, demo, "slow-second.json");
  await page.getByRole("button", { name: "Вернуть демо", exact: true }).click();
  await page.evaluate(() => window.pendingNightReads.shift()());
  await expect(page.locator("#scenario-name")).toHaveText("Дом у опушки");
  await expect(page.locator(".night-status")).toHaveAttribute("data-status", "idle");
  await page.getByLabel("Открыть JSON", { exact: true }).setInputFiles({
    name: "slow-world.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(demo.scenario.world)),
  });
  await page.getByRole("button", { name: "Демо ночи", exact: true }).click();
  await page.evaluate(() => window.pendingNightReads.shift()());
  await expect(page.locator("#scenario-name")).toHaveText("Демо ночи · дверь и ловушка");
});

test("управление доступно с клавиатуры на узком экране", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Демо ночи", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Шаг", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("night-turns")).toHaveText("1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath("night-mobile.png"), fullPage: true });
});

test("ошибка исполнения останавливает пуск, показывает ошибку core и допускает reset",
  async ({ page }) => {
    const input = structuredClone(demo);
    input.content.effects.push({
      definitionId: "bad-probability",
      phase: "TURN_START",
      state: {},
      operations: [{
        kind: "discover_trap",
        trapId: "snare",
        probability: { kind: "add", left: 1, right: 1 },
      }],
    });
    input.content.units.find((unit) => unit.definitionId === "wolf").effectIds
      .push("bad-probability");
    const session = createSimulation(input);
    const expected = session.runToEnd().snapshot;
    expect(expected.status).toBe("error");
    await page.clock.install();
    await page.goto("/");
    await upload(page, input);
    await page.getByRole("button", { name: "Пуск", exact: true }).click();
    await page.clock.runFor(2000);
    await expect(page.locator(".night-status")).toHaveAttribute("data-status", "error");
    await expect(page.locator("#night-controls [role=alert]"))
      .toHaveText(expected.error.message);
    await expect(page.getByRole("button", { name: "Шаг", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Пуск", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeDisabled();
    expect(await exportWorld(page)).toEqual(expected.world);
    expect(await journal(page)).toEqual(session.getEvents());
    await page.getByRole("button", { name: "Сброс ночи", exact: true }).click();
    await expect(page.locator("#night-controls [role=alert]")).toBeHidden();
    await expect(page.getByRole("button", { name: "Шаг", exact: true })).toBeEnabled();
  });

test("уничтожение панели отменяет таймер и незавершённый файл", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.evaluate(async () => {
    const { createNightControls } = await import("/src/night-controls.tsx");
    const host = document.createElement("div");
    host.id = "lifecycle-night";
    document.body.prepend(host);
    window.nightUpdates = 0;
    window.nightPanel = createNightControls(host, () => window.nightUpdates++);
  });
  const host = page.locator("#lifecycle-night");
  await host.getByRole("button", { name: "Демо ночи", exact: true }).click();
  await host.getByRole("button", { name: "Пуск", exact: true }).click();
  await page.clock.runFor(350);
  await page.evaluate(() => window.nightPanel.destroy());
  const updates = await page.evaluate(() => window.nightUpdates);
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => window.nightUpdates)).toBe(updates);
  await expect(host).toBeEmpty();
  await page.evaluate(async () => {
    const { createNightControls } = await import("/src/night-controls.tsx");
    window.nightPanel = createNightControls(
      document.getElementById("lifecycle-night"),
      () => window.nightUpdates++,
    );
    const original = File.prototype.text;
    File.prototype.text = function () {
      return new Promise((resolve) => {
        window.finishNightRead = () => original.call(this).then(resolve);
      });
    };
  });
  await host.getByLabel("Загрузить JSON ночи").setInputFiles({
    name: "late.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(demo)),
  });
  await page.evaluate(async () => {
    window.nightPanel.destroy();
    await window.finishNightRead();
  });
  expect(await page.evaluate(() => window.nightUpdates)).toBe(updates);
  await expect(host).toBeEmpty();
});
