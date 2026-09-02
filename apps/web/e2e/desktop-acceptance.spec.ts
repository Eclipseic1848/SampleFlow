import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

async function seedFullAccessUser(databaseUrl: string, username: string) {
  const userId = await seedTestUser(databaseUrl, {
    username,
    displayName: "E2E 桌面验收管理员",
    password: "Desktop@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  await seedTestUser(databaseUrl, {
    username: `${username}_hr_seed`,
    displayName: "E2E 桌面验收人事种子",
    password: "Desktop@123",
    roleCode: "hr",
    roleName: "人事部",
  });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("insert into user_roles(user_id,role_code) values($1,'hr')", [userId]);
  } finally {
    await client.end();
  }
}

async function login(page: import("@playwright/test").Page, username: string) {
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Desktop@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
}

async function expectNoPageOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectHorizontallyReachable(page: import("@playwright/test").Page, locator: import("@playwright/test").Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
}

async function waitForPageReady(page: import("@playwright/test").Page, heading: string) {
  await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("status").filter({ hasText: /^正在/ })).toHaveCount(0);
}

test("桌面关键页面无横向溢出且操作可达", async ({ database, page }) => {
  await seedFullAccessUser(database.url, "e2e_desktop_layout");
  await page.goto("/?page=overview");
  await login(page, "e2e_desktop_layout");
  expect(await page.evaluate(() => navigator.language)).toBe("zh-CN");
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Asia/Shanghai");

  const performanceDetails = page.getByRole("button", { name: "查看销售组织业绩构成" });
  await expectHorizontallyReachable(page, performanceDetails);
  await performanceDetails.click();
  await expect(page.getByRole("dialog", { name: "销售组织 · 业绩构成" })).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "订单业绩", exact: true }).click();
  await page.getByLabel("定位订单").fill("DESKTOP-NO-MATCH");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page).toHaveURL(/orderSearch=DESKTOP-NO-MATCH/);
  await expectHorizontallyReachable(page, page.getByRole("button", { name: "应用筛选" }));

  await page.getByRole("button", { name: "业绩分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "地区与客户单位分析" })).toBeVisible();
  await expectHorizontallyReachable(page, page.getByLabel("分析月份"));

  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  await page.getByLabel("搜索账号").fill("e2e_desktop_layout");
  await page.getByRole("button", { name: "搜索账号" }).click();
  await expect(page).toHaveURL(/accountSearch=e2e_desktop_layout/);
  await expectHorizontallyReachable(page, page.getByRole("button", { name: "创建账号" }));

  const pages = [
    ["overview", "业绩账本总览"],
    ["orders", "订单业绩"],
    ["goals", "目标管理"],
    ["organization", "组织架构"],
    ["approvals", "审批中心"],
    ["accounts", "账号管理"],
    ["analysis", "地区与客户单位分析"],
    ["audits", "审计查询"],
  ] as const;
  for (const [pageId, heading] of pages) {
    await page.goto(`/?page=${pageId}`);
    await waitForPageReady(page, heading);
    await expectHorizontallyReachable(page, page.getByRole("button", { name: "退出登录" }));
    await expectNoPageOverflow(page);
  }

  await page.goto("/?page=accounts");
  const matrixWrapper = page.locator(".permission-matrix-card .orders-table-wrap");
  await expect(matrixWrapper).toBeVisible();
  expect(await matrixWrapper.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expectNoPageOverflow(page);
});

test("八个主要页面的 WCAG 2.2 A/AA critical/serious 自动违规为零", async ({ database, page }) => {
  await seedFullAccessUser(database.url, "e2e_desktop_axe");
  await page.goto("/?page=overview");
  await login(page, "e2e_desktop_axe");

  const pages = [
    ["overview", "业绩账本总览"],
    ["orders", "订单业绩"],
    ["goals", "目标管理"],
    ["organization", "组织架构"],
    ["approvals", "审批中心"],
    ["accounts", "账号管理"],
    ["analysis", "地区与客户单位分析"],
    ["audits", "审计查询"],
  ] as const;
  for (const [pageId, heading] of pages) {
    await page.goto(`/?page=${pageId}`);
    await waitForPageReady(page, heading);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const severe = results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
    expect(severe, `${heading}: ${JSON.stringify(severe, null, 2)}`).toEqual([]);
  }
});

test("200% 桌面缩放仍保留导航、键盘焦点和无遮挡操作", async ({ database, page }) => {
  await seedFullAccessUser(database.url, "e2e_desktop_zoom");
  await page.setViewportSize({ width: 512, height: 768 });
  await page.goto("/?page=overview");
  await login(page, "e2e_desktop_zoom");
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  const navigation = page.locator(".sidebar nav button");
  await expect(navigation).toHaveCount(8);
  for (const item of await navigation.all()) await expect(item.locator("span")).toBeVisible();
  await expect(page.getByRole("button", { name: "业绩总览", exact: true })).toHaveAttribute("aria-current", "page");
  await expectNoPageOverflow(page);

  const skipLink = page.getByRole("link", { name: "跳到主要内容" });
  await navigation.first().focus();
  await page.keyboard.press("Shift+Tab");
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page.getByRole("button", { name: "账号管理", exact: true }).click();
  const heading = page.getByRole("heading", { name: "账号管理", level: 1 });
  await expect(heading).toBeFocused();
  await waitForPageReady(page, "账号管理");
  const tableRegions = page.locator(".orders-table-wrap");
  expect(await tableRegions.count()).toBeGreaterThan(0);
  for (const region of await tableRegions.all()) {
    await expect(region).toHaveAttribute("tabindex", "0");
    await expect(region).toHaveAttribute("role", "region");
    expect(await region.getAttribute("aria-label")).toMatch(/.+/);
  }

  const replay = page.getByRole("button", { name: "重播当前页面新手引导" });
  await expect(replay).toBeVisible();
  const overlap = await page.evaluate(() => {
    const help = document.querySelector<HTMLElement>(".onboarding-replay")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>("main button")].some((button) => {
      const action = button.getBoundingClientRect();
      return action.width > 0 && action.height > 0 && help.left < action.right && help.right > action.left && help.top < action.bottom && help.bottom > action.top;
    });
  });
  expect(overlap).toBe(false);

  await page.setViewportSize({ width: 640, height: 800 });
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
  await expectNoPageOverflow(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
});
