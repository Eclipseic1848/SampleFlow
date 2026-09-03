import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

test("空金额不会变成零元，并保留各业务动作的零值边界", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_money_boundary",
    displayName: "E2E 金额边界",
    password: "Money@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });

  await page.goto("/");
  await page.getByLabel("账号").fill("e2e_money_boundary");
  await page.getByLabel("密码", { exact: true }).fill("Money@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
  await page.route("**/api/performance/orders?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      orders: [{
        id: "42",
        orderNo: "ZERO-ORDER-042",
        customerName: "零金额客户",
        customerUnit: "零金额单位",
        salespersonName: "E2E 金额边界",
        serviceType: null,
        sourceReceivedOn: "2026-09-01",
        originalAmount: "0.00",
        currentRevenue: "0.00",
        countedAmount: "0.00",
        lifecycleState: "zero",
        postedAt: "2026-09-01T00:00:00.000Z",
        departmentName: "测试部门",
        groupName: "测试小组",
        leaderName: null,
        supervisorName: null,
      }],
      previousCursor: null,
      nextCursor: null,
    }),
  }));
  await page.getByRole("link", { name: "订单业绩", exact: true }).click();

  await page.route("**/api/performance/people*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ people: [{ id: "1", displayName: "E2E 金额边界" }] }),
  }));
  let requestCount = 0;
  let submittedAmount: unknown;
  await page.route("**/api/performance/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requestCount += 1;
    submittedAmount = route.request().postDataJSON().amount;
    await route.fulfill({ status: 201, contentType: "application/json", body: '{"id":"1"}' });
  });

  await page.getByRole("button", { name: "录入新订单" }).click();
  const dialog = page.getByRole("dialog", { name: "录入订单业绩" });
  await dialog.getByLabel("订单编号").fill("MONEY-BOUNDARY-001");
  await dialog.getByLabel("日期", { exact: true }).fill("2026-09-01");
  await dialog.getByLabel("客户姓名").fill("金额边界客户");
  await dialog.getByLabel("客户单位", { exact: true }).fill("金额边界单位");
  await dialog.getByLabel("省份").selectOption("EXT-TRADE");
  await dialog.getByLabel("业务员", { exact: true }).selectOption("1");

  const amount = dialog.getByLabel("营业额");
  await dialog.getByRole("button", { name: "确认入账" }).click();
  expect(requestCount).toBe(0);
  await expect(amount).toBeFocused();
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("请输入系统营业额。")).toBeVisible();

  await amount.fill("0");
  await dialog.getByRole("button", { name: "确认入账" }).click();
  await expect(dialog).not.toBeVisible();
  expect(requestCount).toBe(1);
  expect(submittedAmount).toBe(0);

  let eventRequestCount = 0;
  let firstIncludeAmount: unknown;
  await page.route("**/api/performance/orders/42/events", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: [], lifecycleState: "zero", allowedActions: ["first_include"] }),
      });
      return;
    }
    eventRequestCount += 1;
    firstIncludeAmount = route.request().postDataJSON().amount;
    await route.fulfill({ status: 201, contentType: "application/json", body: '{"id":"2"}' });
  });
  await page.getByRole("row").filter({ hasText: "ZERO-ORDER-042" }).getByRole("button", { name: "查看 / 调整" }).click();
  const firstInclude = page.getByLabel("首次计入金额");
  await page.getByRole("button", { name: "确认追加事件" }).click();
  expect(eventRequestCount).toBe(0);
  await expect(firstInclude).toHaveAttribute("aria-invalid", "true");
  await firstInclude.fill("0");
  await page.getByRole("button", { name: "确认追加事件" }).click();
  expect(eventRequestCount).toBe(0);
  await expect(page.getByText("首次计入金额格式无效。")).toBeVisible();
  await firstInclude.fill("0.01");
  await page.getByLabel("原因（必填）").fill("首次计入最小有效金额");
  await page.getByRole("button", { name: "确认追加事件" }).click();
  expect(eventRequestCount).toBe(1);
  expect(firstIncludeAmount).toBe(0.01);
});
