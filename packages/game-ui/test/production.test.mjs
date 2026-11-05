import { test, expect } from "@playwright/test";

test("production-сборка загружает API core и отображает карту", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".phaser-map")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#map canvas")).toBeVisible();
  await expect(page.getByRole("table", { name: "Карта 14 × 10" })).toBeVisible();
  await expect(page.locator("td[data-x]")).toHaveCount(140);
  await expect(page.locator(".tile .token")).toHaveCount(5);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("map-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Демо ночи", exact: true }).click();
  await page.getByRole("button", { name: "Шаг", exact: true }).click();
  await expect(page.getByTestId("night-turns")).toHaveText("1");
  await expect(page.getByTestId("event-count")).not.toHaveText("0");
  expect(errors).toEqual([]);
});
