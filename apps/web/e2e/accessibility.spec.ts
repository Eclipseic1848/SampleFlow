import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

async function login(page: import("@playwright/test").Page, username: string) {
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Access@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
}

async function expectVisibleControlsNamed(page: import("@playwright/test").Page) {
  const controls = page.locator('button, input, select, textarea, [role="button"], [role="img"], [role="group"]');
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (await control.isVisible()) await expect(control).toHaveAccessibleName(/\S/);
  }
}

test("账号弹窗约束键盘焦点，并在写入失败后保留输入安全重试", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_access_admin",
    displayName: "E2E 无障碍管理员",
    password: "Access@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  const setup=new Client({connectionString:database.url});await setup.connect();
  await setup.query("insert into people(display_name,identity_source,source_key) values('E2E 精确标识人员','e2e','precise-id-person')");
  await setup.end();
  await page.goto("/?page=accounts");
  await login(page, "e2e_access_admin");

  const trigger = page.getByRole("button", { name: "创建账号" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "创建系统账号" });
  const close = dialog.getByRole("button", { name: "关闭" });
  const submit = dialog.getByRole("button", { name: "创建账号" });
  await expect(dialog).toBeFocused();
  await submit.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(submit).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  let createMode: "known-failure" | "pass" | "uncertain" = "known-failure";
  let createBody:Record<string,unknown>|null=null;
  let releaseKnownFailure!: () => void;
  const knownFailureGate = new Promise<void>((resolve) => { releaseKnownFailure = resolve; });
  await page.route("**/api/admin/users", async (route) => {
    if (route.request().method() === "POST" && createMode === "known-failure") {
      createMode = "pass";
      createBody=route.request().postDataJSON() as Record<string,unknown>;
      await knownFailureGate;
      await route.fulfill({ status: 503, contentType: "text/plain", body: "Service unavailable" });
      return;
    }
    if (route.request().method() === "POST" && createMode === "uncertain") {
      createMode = "pass";
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await trigger.click();
  const retryDialog = page.getByRole("dialog", { name: "创建系统账号" });
  await retryDialog.getByLabel("登录账号").fill("e2e_access_created");
  await retryDialog.getByLabel("账号显示姓名").fill("E2E 重试保留输入");
  await retryDialog.getByLabel("绑定已有人员（可选）").selectOption({label:"E2E 精确标识人员"});
  const retrySubmit = retryDialog.locator('button[type="submit"]');
  await retrySubmit.click();
  await expect(retrySubmit).toHaveAttribute("aria-busy", "true");
  await expect(retryDialog.getByRole("button", { name: "关闭" })).toBeDisabled();
  await expect(retryDialog.getByRole("button", { name: "取消" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator(".modal-backdrop").dispatchEvent("mousedown");
  await expect(retryDialog).toBeVisible();
  releaseKnownFailure();
  await expect(retryDialog.getByRole("alert")).toHaveText("创建账号失败，请重试。");
  expect(typeof createBody?.personId).toBe("string");
  await expect(retryDialog.getByLabel("登录账号")).toHaveValue("e2e_access_created");
  await expect(retryDialog.getByLabel("账号显示姓名")).toHaveValue("E2E 重试保留输入");
  await retryDialog.getByRole("button", { name: "创建账号" }).click();
  await expect(retryDialog.getByText("请立即安全保存临时密码，关闭后无法再次查看。", { exact: true })).toBeVisible();
  await retryDialog.getByRole("button", { name: "我已安全保存" }).click();

  createMode = "uncertain";
  await trigger.click();
  const uncertainDialog = page.getByRole("dialog", { name: "创建系统账号" });
  await uncertainDialog.getByLabel("登录账号").fill("e2e_access_uncertain");
  await uncertainDialog.getByLabel("账号显示姓名").fill("E2E 响应丢失账号");
  await uncertainDialog.getByRole("button", { name: "创建账号" }).click();
  await expect(uncertainDialog).toBeHidden();
  await expect(page.getByText("创建结果不确定，已重新查询该账号；如账号已存在，请重置密码生成新的临时密码。", { exact: true })).toBeVisible();
  const uncertainRow = page.getByRole("row").filter({ hasText: "e2e_access_uncertain" });
  await expect(uncertainRow).toBeVisible();
  await uncertainRow.getByRole("button", { name: "重置密码" }).click();
  await expect(page.getByRole("dialog", { name: "临时密码已生成" })).toBeVisible();
});

test("图表和关键状态具有不依赖颜色的文本等价信息", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_access_hr",
    displayName: "E2E 无障碍人事",
    password: "Access@123",
    roleCode: "hr",
    roleName: "人事部",
  });
  await page.route("**/api/performance/dashboard", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.monthly = [{ month: `${body.month.slice(0, 4)}-01`, total: "9007199254740993.01" }];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/?page=overview");
  await login(page, "e2e_access_hr");

  const chart = page.getByRole("img", { name: /业绩折线图/ });
  await expect(chart).toBeVisible();
  await expect(chart.locator("desc")).toContainText("1月 ¥9,007,199,254,740,993.01");
  await expect(page.getByText("待处理审批", { exact: true })).toBeVisible();
  await expect(page.getByText(/条授权范围事件/)).toBeVisible();
});

test("组织写入明确失败后保留输入并可重试", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_access_org",
    displayName: "E2E 组织无障碍",
    password: "Access@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  let failOnce = true;
  let releaseOrganization!: () => void;
  const organizationGate = new Promise<void>((resolve) => { releaseOrganization = resolve; });
  await page.route("**/api/admin/organization/units", async (route) => {
    if (route.request().method() === "POST" && failOnce) {
      failOnce = false;
      await organizationGate;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"组织服务暂不可用，请重试"}' });
      return;
    }
    await route.continue();
  });
  await page.goto("/?page=organization");
  await login(page, "e2e_access_org");
  await page.getByRole("button", { name: "新增组织" }).click();
  const dialog = page.getByRole("dialog", { name: "新增组织单元" });
  await dialog.getByLabel("名称").fill("E2E 重试部门");
  const submit = dialog.locator('button[type="submit"]');
  await submit.click();
  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "关闭" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator(".modal-backdrop").dispatchEvent("mousedown");
  await expect(dialog).toBeVisible();
  releaseOrganization();
  await expect(dialog.getByRole("alert")).toHaveText("组织服务暂不可用，请重试");
  await expect(dialog.getByLabel("名称")).toHaveValue("E2E 重试部门");
  await dialog.getByRole("button", { name: "保存组织" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("E2E 重试部门", { exact: true })).toBeVisible();
});

test("八个主要页面的可见控件和图表均有可访问名称", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_access_all",
    displayName: "E2E 全页无障碍",
    password: "Access@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  await seedTestUser(database.url, {
    username: "e2e_access_hr_seed",
    displayName: "E2E 人事角色种子",
    password: "Access@123",
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

  await page.goto("/?page=accounts");
  await login(page, "e2e_access_all");
  for (const name of ["账号管理", "业绩总览", "目标管理", "订单业绩", "业绩分析", "组织架构", "审批中心", "审计查询"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expectVisibleControlsNamed(page);
  }
});
