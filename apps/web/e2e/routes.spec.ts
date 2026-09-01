import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

async function login(page: import("@playwright/test").Page, username: string) {
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Routes@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
}

test("八个主要页面使用稳定 URL、标题并支持刷新和浏览器历史", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_routes_all",
    displayName: "E2E 路由全权限",
    password: "Routes@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  await seedTestUser(database.url, {
    username: "e2e_routes_hr_seed",
    displayName: "E2E 路由人事角色种子",
    password: "Routes@123",
    roleCode: "hr",
    roleName: "人事部",
  });
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query("insert into user_roles(user_id,role_code) values($1,'hr')", [userId]);
  } finally {
    await client.end();
  }

  await page.goto("/?page=overview");
  await login(page, "e2e_routes_all");

  const routes = [
    { id: "overview", nav: "业绩总览", heading: "业绩账本总览", title: "业绩总览 — SampleFlow" },
    { id: "orders", nav: "订单业绩", heading: "订单业绩", title: "订单业绩 — SampleFlow" },
    { id: "goals", nav: "目标管理", heading: "目标管理", title: "目标管理 — SampleFlow" },
    { id: "organization", nav: "组织架构", heading: "组织架构", title: "组织架构 — SampleFlow" },
    { id: "approvals", nav: "审批中心", heading: "审批中心", title: "审批中心 — SampleFlow" },
    { id: "accounts", nav: "账号管理", heading: "账号管理", title: "账号管理 — SampleFlow" },
    { id: "analysis", nav: "业绩分析", heading: "地区与客户单位分析", title: "业绩分析 — SampleFlow" },
    { id: "audits", nav: "审计查询", heading: "审计查询", title: "审计查询 — SampleFlow" },
  ] as const;

  for (const route of routes) {
    if (route.id !== "overview") await page.getByRole("button", { name: route.nav }).click();
    await expect(page).toHaveURL(new RegExp(`[?&]page=${route.id}(?:&|$)`));
    await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
    await expect(page).toHaveTitle(route.title);
  }

  await page.goBack();
  await expect(page).toHaveURL(/[?&]page=analysis(?:&|$)/);
  await expect(page.getByRole("heading", { name: "地区与客户单位分析", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "审计查询", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "审计查询", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "账号管理" }).click();
  await page.getByLabel("搜索账号").fill("e2e_routes");
  await page.getByRole("button", { name: "搜索账号" }).click();
  await expect(page).toHaveURL(/accountSearch=e2e_routes/);
  await page.getByRole("button", { name: "账号管理" }).click();
  await expect(page).toHaveURL(/accountSearch=e2e_routes/);
  await page.getByRole("button", { name: "审计查询" }).click();
  await page.goBack();
  await expect(page.getByLabel("搜索账号")).toHaveValue("e2e_routes");

  await page.goto("/?page=accounts");
  await page.evaluate(()=>window.history.pushState({},"","/?page=toString"));
  await page.goBack();
  await page.goForward();
  await expect(page).toHaveURL(/[?&]page=accounts(?:&|$)/);
  await expect(page.getByRole("heading", { name: "账号管理", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录系统", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("登录 — SampleFlow");
});

test("无权限业务路由显示明确 403 而不是其他页面或空数据", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_routes_admin",
    displayName: "E2E 路由管理员",
    password: "Routes@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  await page.goto("/?page=analysis");
  await login(page, "e2e_routes_admin");
  await expect(page.getByRole("heading", { name: "无法访问业绩分析" })).toBeVisible();
  await expect(page.getByText("403 · 当前账号没有业绩分析权限。", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("业绩分析 — SampleFlow");
  await expect(page.getByText("本月没有已映射省份事件。", { exact: true })).toHaveCount(0);
});
