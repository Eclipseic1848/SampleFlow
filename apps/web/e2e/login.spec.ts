import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { withMigratedTestDatabase } from "../../api/src/test-support/test-database.js";

const apiRoot = fileURLToPath(new URL("../../api/", import.meta.url));
const { Client } = pg;
const apiPort=process.env.SAMPLEFLOW_E2E_API_PORT;
const webPort=process.env.SAMPLEFLOW_E2E_WEB_PORT;
if(!apiPort||!webPort)throw new Error("缺少隔离 E2E 端口");
const apiBaseUrl=`http://127.0.0.1:${apiPort}`;
const webBaseUrl=`http://127.0.0.1:${webPort}`;

async function waitForApi(url: string, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("测试 API 在就绪前退出");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // API 尚未监听时继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待测试 API 就绪超时");
}

test("销售助理可通过真实 API 登录", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "e2e_sales_assistant",
      displayName: "E2E 销售助理",
      password: "E2ePass@123",
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        API_PORT: apiPort,
        APP_ORIGINS: webBaseUrl,
        DATABASE_URL: database.url,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      const guestResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/me"));
      await page.goto("/");
      expect((await guestResponse).status()).toBe(401);
      await expect(page.getByRole("heading", { name: "登录系统" })).toBeVisible();
      await page.getByLabel("账号").fill("e2e_sales_assistant");
      await page.getByLabel("密码").fill("E2ePass@123");

      const loginResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/auth/login") && response.request().method() === "POST"
      );
      const dashboardResponse = page.waitForResponse((response) =>
        response.url().includes("/api/performance/dashboard")
      );
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      expect((await loginResponse).status()).toBe(200);
      expect((await dashboardResponse).status()).toBe(200);
      await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});

test("首次登录用户看到密码强度并完成改密", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "e2e_password_change",
      displayName: "E2E 首次改密用户",
      password: "Before@123",
      mustChangePassword: true,
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        API_PORT: apiPort,
        APP_ORIGINS: webBaseUrl,
        DATABASE_URL: database.url,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_password_change");
      await page.getByLabel("密码").fill("Before@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();

      await expect(page.getByRole("heading", { name: "请修改初始密码" })).toBeVisible();
      await expect(page.getByText("6—128 位，并包含英文字母、数字和符号")).toBeVisible();
      await page.getByLabel("当前密码").fill("Before@123");
      await page.getByLabel("新密码").fill("Abc@12");
      await expect(page.getByText("密码强度：弱")).toBeVisible();
      const dashboardResponse = page.waitForResponse((response) =>
        response.url().includes("/api/performance/dashboard") && response.status() === 200
      );
      await page.getByRole("button", { name: "保存新密码" }).click();
      await dashboardResponse;
      await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});

test("系统管理员在账号管理页查看只读角色权限说明", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, {
      username: "e2e_system_admin",
      displayName: "E2E 系统管理员",
      password: "Admin@123",
      roleCode: "system_admin",
      roleName: "系统管理员",
    });

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: {
        ...process.env,
        API_PORT: apiPort,
        APP_ORIGINS: webBaseUrl,
        DATABASE_URL: database.url,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_system_admin");
      await page.getByLabel("密码").fill("Admin@123");
      const accountsResponse = page.waitForResponse((response) => response.url().endsWith("/api/admin/users"));
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();

      expect((await accountsResponse).status()).toBe(200);
      await expect(page.getByRole("button", { name: "账号管理" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("button", { name: "业绩总览" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "订单业绩" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "目标管理" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "角色权限说明" })).toBeVisible();
      await expect(page.getByText("多角色账号取各角色权限并集；系统管理员角色本身不增加业务权限")).toBeVisible();

      const administratorRow = page.getByRole("row").filter({ hasText: "系统管理员" }).last();
      await expect(administratorRow).toContainText("无业务范围");
      await expect(administratorRow).toContainText("业务查看与导出");
      const salespersonRow = page.getByRole("row").filter({ hasText: "业务员" }).last();
      await expect(salespersonRow).toContainText("仅本人");

      const matrixScroller = page.locator(".permission-matrix-card .orders-table-wrap");
      expect(await matrixScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});

test("目标未生效时页面不提供正式报表，生效后才可查看", async ({ page }) => {
  await withMigratedTestDatabase(async (database) => {
    const userId = await seedTestUser(database.url, {
      username: "e2e_salesperson_report",
      displayName: "E2E 业务员",
      password: "Report@123",
      roleCode: "salesperson",
      roleName: "业务员",
    });
    const client = new Client({ connectionString: database.url });
    await client.connect();
    await client.query(
      `with owner as (
         select id as person_id from people where user_id=$1
       ), active_goal as (
         insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         select '2026-08-01','personal',$1,person_id from owner returning id
       ), pending_goal as (
         insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         select '2026-09-01','personal',$1,person_id from owner returning id
       )
       insert into goal_versions(goal_id,version_no,amount,status,created_by,change_reason)
       select id,1,1000,'active',$1,'浏览器门禁测试' from active_goal
       union all
       select id,1,2000,'pending_hr',$1,'浏览器门禁测试' from pending_goal`,
      [userId],
    );
    await client.end();

    const api = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: apiRoot,
      env: { ...process.env, API_PORT: apiPort, APP_ORIGINS:webBaseUrl, DATABASE_URL: database.url, NODE_ENV: "test" },
      stdio: "ignore",
    });

    try {
      await waitForApi(`${apiBaseUrl}/api/ready`, () => api.exitCode !== null);
      await page.goto("/");
      await page.getByLabel("账号").fill("e2e_salesperson_report");
      await page.getByLabel("密码").fill("Report@123");
      await page.getByRole("button", { name: "进入 SampleFlow" }).click();
      await page.getByRole("button", { name: "目标管理" }).click();

      const pendingRow = page.getByRole("row").filter({ hasText: "2026-09" });
      await expect(pendingRow).toContainText("待人事审批");
      await expect(pendingRow.getByRole("button", { name: "查看正式报表" })).toHaveCount(0);

      const activeRow = page.getByRole("row").filter({ hasText: "2026-08" });
      const reportResponse = page.waitForResponse((response) => response.url().includes("/api/performance/formal-reports/") && response.status() === 200);
      await activeRow.getByRole("button", { name: "查看正式报表" }).click();
      await reportResponse;
      await expect(page.getByRole("heading", { name: "正式业绩报表" })).toBeVisible();
      await expect(page.getByText("目标已生效，达成率按该层级目标独立计算")).toBeVisible();
      await expect(page.getByRole("dialog").getByText("¥1,000.00", { exact: true })).toBeVisible();
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});
