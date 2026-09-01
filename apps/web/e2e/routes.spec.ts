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

test("退出失败保留会话，受保护请求只在 401 时回到登录", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_session_lifecycle",
    displayName: "E2E 会话生命周期",
    password: "Routes@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });
  await page.goto("/?page=orders&orderSearch=keep");
  await login(page, "e2e_session_lifecycle");
  await expect(page.getByRole("heading", { name: "订单业绩", exact: true })).toBeVisible();

  let logoutFailure: "server" | "network" = "server";
  await page.route("**/api/auth/logout", async (route) => {
    if (logoutFailure === "server") {
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"message":"退出失败"}' });
    } else {
      await route.abort("failed");
    }
  });

  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("alert")).toHaveText("退出登录失败，会话仍然有效，请重试。");
  await expect(page.getByRole("heading", { name: "订单业绩", exact: true })).toBeVisible();

  logoutFailure = "network";
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("alert")).toHaveText("无法确认退出结果，会话仍保留，请检查网络后重试。");
  await expect(page.getByRole("heading", { name: "订单业绩", exact: true })).toBeVisible();

  let orderStatus = 403;
  await page.route("**/api/performance/orders?*", async (route) => {
    await route.fulfill({ status: orderStatus, contentType: "application/json", body: '{"message":"权限或会话失效"}' });
  });
  await page.getByRole("button", { name: "刷新订单" }).click();
  await expect(page.getByText("当前账号没有订单查看权限。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录系统", exact: true })).toHaveCount(0);

  await page.route("**/api/exports/performance.csv*", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: '{"message":"会话已过期"}' });
  });
  await page.getByRole("button", { name: "导出全部匹配订单" }).click();
  await expect(page.getByRole("heading", { name: "登录系统", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?page=orders&orderSearch=keep$/);
});

test("目标创建原样提交超出 JavaScript 安全整数范围的标识", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_goal_bigint",
    displayName: "E2E 大整数目标",
    password: "Routes@123",
    roleCode: "sales_manager",
    roleName: "销售经理",
  });
  const personId = "9007199254740993";
  await page.route("**/api/goals/options?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ parentGoals: [], owners: [{ personId, name: "大整数责任人", orgUnitId: null, orgUnitName: null }] }) });
  });
  let submitted: Record<string, unknown> | null = null;
  await page.route("**/api/goals", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, contentType: "application/json", body: '{"goal":{}}' });
  });
  await page.goto("/?page=goals");
  await login(page, "e2e_goal_bigint");
  await page.getByRole("button", { name: "下达目标" }).click();
  await expect(page.getByLabel("目标责任人")).toHaveValue(`${personId}:`);
  await page.getByLabel("目标金额").fill("1000");
  await page.getByRole("button", { name: "提交待确认" }).click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted).toMatchObject({ ownerPersonId: personId, orgUnitId: null, parentGoalId: null });
});

test("总览失败后显示错误并可重试成功", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_overview_retry",
    displayName: "E2E 总览重试",
    password: "Routes@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });
  let fail=true;
  await page.route("**/api/performance/dashboard",async(route)=>{if(fail){await route.fulfill({status:503,contentType:"application/json",body:'{"message":"总览暂不可用"}'});return;}await new Promise((resolve)=>setTimeout(resolve,200));await route.continue();});
  await page.goto("/");
  await login(page,"e2e_overview_retry");
  await expect(page.getByRole("alert")).toHaveText("总览加载失败");
  await expect(page.getByText("总览暂时不可用",{exact:true})).toBeVisible();
  fail=false;
  await page.getByRole("button",{name:"重试总览"}).click();
  await expect(page.getByText("正在加载真实业绩账本…",{exact:true})).toBeVisible();
  await expect(page.getByText(/月 · 原始账本，不代表正式绩效结果/)).toBeVisible();
});
