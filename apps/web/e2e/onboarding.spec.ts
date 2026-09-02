import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

test.use({ onboardingEnabled: true });

async function login(page: import("@playwright/test").Page, username: string, password = "Tour@123") {
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
}

async function completeTour(page: import("@playwright/test").Page) {
  const dialog = page.locator(".onboarding-bubble");
  while (await dialog.getByRole("button", { name: "完成" }).count() === 0) {
    await dialog.getByRole("button", { name: "下一步" }).click();
  }
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toBeHidden();
}

test("总览等待异步内容就绪后再播放完整引导",async({database,page})=>{
  await seedTestUser(database.url,{
    username:"e2e_tour_overview_ready",
    displayName:"E2E 总览引导就绪",
    password:"Tour@123",
    roleCode:"sales_assistant",
    roleName:"销售助理",
  });
  let releaseDashboard!:()=>void;
  let markRequested!:()=>void;
  const dashboardReleased=new Promise<void>((resolve)=>{releaseDashboard=resolve;});
  const dashboardRequested=new Promise<void>((resolve)=>{markRequested=resolve;});
  await page.route("**/api/performance/dashboard",async(route)=>{markRequested();await dashboardReleased;await route.continue();});
  await page.goto("/?page=overview");
  await login(page,"e2e_tour_overview_ready");
  await dashboardRequested;
  const dialog=page.locator(".onboarding-bubble");
  await expect(page.getByRole("heading",{name:"业绩账本总览"})).toBeVisible();
  await expect(dialog).toBeHidden();
  releaseDashboard();
  await expect(dialog.getByRole("heading",{name:"从这里进入工作页面"})).toBeVisible();
  for(const title of ["业绩总览","目标与账本指标","最近业绩事件"]){
    await dialog.getByRole("button",{name:"下一步"}).click();
    await expect(dialog.getByRole("heading",{name:title})).toBeVisible();
  }
  await dialog.getByRole("button",{name:"跳过本页"}).click();
});

test("首次自动播放，完成后不再打扰且可以手动重播", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_tour_persistence",
    displayName: "E2E 引导销售助理",
    password: "Tour@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });
  await seedTestUser(database.url, {
    username: "e2e_tour_second_user",
    displayName: "E2E 引导第二用户",
    password: "Tour@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });

  await page.goto("/?page=orders");
  await login(page, "e2e_tour_persistence");

  const dialog = page.locator(".onboarding-bubble");
  await expect(dialog.getByRole("heading", { name: "订单业绩" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("heading", { name: "录入与导入" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("heading", { name: "订单业绩" })).toBeVisible();
  await completeTour(page);

  const pageKey = `sampleflow:onboarding:v1:${userId}:sales_assistant:orders`;
  expect(await page.evaluate((key) => localStorage.getItem(key), pageKey)).toBe("completed");
  await page.reload();
  await expect(dialog).toBeHidden();

  const replay = page.getByRole("button", { name: "重播当前页面新手引导" });
  await expect(replay).toBeVisible();
  await replay.click();
  await expect(dialog.getByRole("heading", { name: "订单业绩" })).toBeVisible();
  await dialog.getByRole("button", { name: "跳过本页" }).click();

  await page.getByRole("button", { name: "业绩分析", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "地区与客户分析" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "订单业绩", exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  const analysisKey = `sampleflow:onboarding:v1:${userId}:sales_assistant:analysis`;
  expect(await page.evaluate((key) => localStorage.getItem(key), analysisKey)).toBeNull();

  await page.getByRole("button", { name: "退出登录" }).click();
  await login(page, "e2e_tour_second_user");
  await expect(dialog.getByRole("heading", { name: "订单业绩" })).toBeVisible();
  await dialog.getByRole("button", { name: "跳过本页" }).click();
});

test("权限决定页面范围，角色变化使用独立状态且八个页面均有引导", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_tour_roles",
    displayName: "E2E 引导角色切换",
    password: "Tour@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  await seedTestUser(database.url, {
    username: "e2e_tour_hr_seed",
    displayName: "E2E 引导人事角色种子",
    password: "Tour@123",
    roleCode: "hr",
    roleName: "人事部",
  });
  await seedTestUser(database.url, {
    username: "e2e_tour_assistant_seed",
    displayName: "E2E 引导销售助理角色种子",
    password: "Tour@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });

  await page.goto("/?page=orders");
  await login(page, "e2e_tour_roles");
  await expect(page.getByRole("heading", { name: "无法访问订单业绩" })).toBeVisible();
  await expect(page.locator(".onboarding-bubble")).toBeHidden();
  await expect(page.getByRole("button", { name: "重播当前页面新手引导" })).toHaveCount(0);

  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  const dialog = page.locator(".onboarding-bubble");
  await expect(dialog.getByRole("heading", { name: "从这里进入工作页面" })).toBeVisible();
  await dialog.getByRole("button", { name: "跳过本页" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();

  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query("insert into user_roles(user_id,role_code) values($1,'hr'),($1,'sales_assistant')", [userId]);
  } finally {
    await client.end();
  }

  await login(page, "e2e_tour_roles");
  await expect(dialog.getByRole("heading", { name: "从这里进入工作页面" })).toBeVisible();
  await dialog.getByRole("button", { name: "跳过本页" }).click();

  const routes = [
    ["业绩总览", "业绩总览"],
    ["目标管理", "目标管理"],
    ["订单业绩", "订单业绩"],
    ["业绩分析", "地区与客户分析"],
    ["组织架构", "组织架构"],
    ["审批中心", "审批中心"],
    ["审计查询", "审计查询"],
  ] as const;
  for (const [navigation, firstStep] of routes) {
    await page.getByRole("button", { name: navigation, exact: true }).click();
    await expect(dialog.getByRole("heading", { name: firstStep })).toBeVisible();
    if (navigation === "订单业绩") {
      for (let index = 0; index < 4; index += 1) await dialog.getByRole("button", { name: "下一步" }).click();
      await expect(dialog.getByRole("heading", { name: "记账治理工作台" })).toBeVisible();
      await expect(dialog).toContainText("当前组合角色另有订单录入与合法事件调整权限");
      await expect(dialog).not.toContainText("不能亲自修改业绩");
    }
    await dialog.getByRole("button", { name: "跳过本页" }).click();
  }
});

test("支持焦点约束、键盘退出、跳过全部和无障碍", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_tour_accessibility",
    displayName: "E2E 引导无障碍",
    password: "Tour@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?page=orders");
  await login(page, "e2e_tour_accessibility");
  const dialog = page.locator(".onboarding-bubble");
  await expect(dialog).toBeFocused();
  const viewport = page.viewportSize()!;
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);
  const controls = dialog.getByRole("button");
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();
  await dialog.focus();
  const spotlightDuration = await page.locator(".onboarding-spotlight").evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
  expect(spotlightDuration).toBeLessThanOrEqual(0.001);

  const backgroundNavigation = page.locator('nav button[aria-label="业绩分析"]');
  const box = await backgroundNavigation.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page).toHaveURL(/[?&]page=orders(?:&|$)/);

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);

  await controls.last().focus();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const replayOrders = page.getByRole("button", { name: "重播当前页面新手引导" });
  await expect(replayOrders).toBeFocused();
  const pageKey = `sampleflow:onboarding:v1:${userId}:sales_assistant:orders`;
  expect(await page.evaluate((key) => localStorage.getItem(key), pageKey)).toBeNull();

  await replayOrders.click();
  await dialog.getByRole("button", { name: "跳过全部引导" }).click();
  const allKey = `sampleflow:onboarding:v1:${userId}:sales_assistant:all`;
  expect(await page.evaluate((key) => localStorage.getItem(key), allKey)).toBe("completed");
  await page.getByRole("button", { name: "业绩分析", exact: true }).click();
  await expect(dialog).toBeHidden();
  const replayAnalysis = page.getByRole("button", { name: "重播当前页面新手引导" });
  await expect(replayAnalysis).toBeVisible();
  await replayAnalysis.click();
  await expect(dialog.getByRole("heading", { name: "地区与客户分析" })).toBeVisible();
});
