import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { withMigratedTestDatabase } from "../../api/src/test-support/test-database.js";

const apiRoot = fileURLToPath(new URL("../../api/", import.meta.url));

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
        API_PORT: "3100",
        DATABASE_URL: database.url,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });

    try {
      await waitForApi("http://127.0.0.1:3100/api/ready", () => api.exitCode !== null);
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
      await expect(page.getByRole("heading", { name: "业绩总览" })).toBeVisible();
    } finally {
      if (api.exitCode === null) {
        api.kill();
        await once(api, "exit");
      }
    }
  });
});
