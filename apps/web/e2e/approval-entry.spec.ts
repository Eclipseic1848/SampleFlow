import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

test("总览待处理审批支持键盘进入、确认、批准、拒绝和权限隔离", async ({ database, page }) => {
  test.setTimeout(120_000);
  for (const role of ["sales_manager", "general_manager", "hr", "sales_assistant"]) {
    await seedTestUser(database.url, { username: role, displayName: `测试 ${role}`, password: "Approval@123", roleCode: role, roleName: role });
  }
  async function login(role: string) {
    await page.goto("/");
    if (await page.getByRole("button", { name: "退出登录" }).isVisible()) {
      await page.getByRole("button", { name: "退出登录" }).click();
    }
    await page.getByLabel("账号", { exact: true }).fill(role);
    await page.getByLabel("密码", { exact: true }).fill("Approval@123");
    await page.getByRole("button", { name: "进入 SampleFlow" }).click();
    await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  }
  async function enterPending(count: number) {
    await page.goto("/?page=overview&approvalTab=changes");
    const entry = page.getByRole("button", { name: "查看待处理审批", exact: true });
    await expect(entry).toHaveText(String(count));
    if (count === 1) await page.screenshot({ path: test.info().outputPath("approval-entry.png") });
    await entry.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/page=approvals&approvalTab=goals/);
    await expect(page.getByRole("heading", { name: "待确认与待审批目标", exact: true })).toBeVisible();
    await expect(page.locator("#approval-goals .orders-toolbar [role=status]")).toHaveText(`${count} 条记录`);
    await page.goBack();
    await expect(page).toHaveURL(/page=overview&approvalTab=changes/);
    await entry.click();
    await expect(page.locator("#approval-goals .orders-toolbar [role=status]")).toHaveText(`${count} 条记录`);
  }
  async function create(month: string) {
    await page.getByRole("link", { name: "目标管理", exact: true }).click();
    await page.getByRole("button", { name: "下达目标", exact: true }).click();
    await page.getByLabel("目标月份").fill(month);
    await expect(page.getByLabel("目标责任人")).toBeEnabled();
    await page.getByLabel("目标金额").fill("1000");
    await page.getByRole("button", { name: "提交待确认" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await enterPending(1);
    await page.getByRole("button", { name: "确认目标", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认目标", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await enterPending(0);
  }
  async function decide(approve: boolean) {
    await enterPending(1);
    await page.getByRole("button", { name: approve ? "批准" : "拒绝", exact: true }).click();
    await page.getByLabel("审批意见").fill(approve ? "测试核对通过" : "测试拒绝原因");
    await page.getByRole("button", { name: approve ? "确认批准" : "确认拒绝", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("当前没有待确认或待审批目标。", { exact: true })).toBeVisible();
    await enterPending(0);
  }
  await login("sales_manager");
  await create("2026-09");
  await login("general_manager");
  await decide(true);
  await login("hr");
  await decide(true);
  await login("sales_manager");
  await page.getByRole("link", { name: "目标管理", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看正式报表" })).toBeVisible();
  await page.getByRole("button", { name: "版本与记录" }).click();
  await expect(page.getByRole("dialog")).toContainText("测试核对通过");
  await page.keyboard.press("Escape");
  await create("2026-10");
  await login("general_manager");
  await page.setViewportSize({ width: 1024, height: 800 });
  await decide(false);
  await login("sales_manager");
  await page.getByRole("link", { name: "目标管理", exact: true }).click();
  const rejected = page.getByRole("row").filter({ hasText: "2026-10" });
  await rejected.getByRole("button", { name: "版本与记录" }).click();
  await expect(page.getByRole("dialog")).toContainText("测试拒绝原因");
  await page.keyboard.press("Escape");
  await login("sales_assistant");
  await page.goto("/?page=overview");
  await expect(page.locator(".metric").filter({ hasText: "待处理审批" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看待处理审批" })).toHaveCount(0);
  await page.goto("/?page=approvals");
  await expect(page.getByRole("heading", { name: "无法访问审批中心" })).toBeVisible();
  expect((await page.request.get("/api/goals?pendingOnly=true")).status()).toBe(403);
});
