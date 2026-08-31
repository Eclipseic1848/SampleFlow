import { expect, test } from "./full-stack.js";

test("P1 共享验收入口连接隔离 Web、API 和数据库", async ({ database, page }) => {
  expect(database.name).toMatch(/^sampleflow_test_[a-f0-9]+$/);
  expect(new URL(database.apiBaseUrl).port).not.toBe(new URL(database.webBaseUrl).port);
  await page.goto("/");
  await expect(page.getByText("前端、API 与数据库已连接")).toBeVisible();
});
