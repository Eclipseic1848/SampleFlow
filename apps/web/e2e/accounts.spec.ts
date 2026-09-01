import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

test("系统管理员搜索分页账号并审计固定角色组合变更", async ({ database, page }) => {
  const adminId = await seedTestUser(database.url, {
    username: "e2e_accounts_admin",
    displayName: "E2E 账号管理员",
    password: "Accounts@123",
    roleCode: "system_admin",
    roleName: "系统管理员",
  });
  const targetId = await seedTestUser(database.url, {
    username: "e2e_role_target",
    displayName: "E2E 角色变更目标",
    password: "Accounts@123",
    roleCode: "salesperson",
    roleName: "业务员",
  });
  const setup = new Client({ connectionString: database.url });
  await setup.connect();
  try {
    await setup.query(
      `insert into users(username,display_name,password_hash,password_salt,must_change_password)
       select 'e2e_account_page_'||lpad(series::text,2,'0'),'E2E 分页账号 '||lpad(series::text,2,'0'),source.password_hash,source.password_salt,false
       from generate_series(1,55) series cross join users source where source.id=$1`,
      [adminId],
    );
    await setup.query(
      `insert into user_roles(user_id,role_code,assigned_by)
       select id,'salesperson',$1 from users where username like 'e2e_account_page_%'`,
      [adminId],
    );

    await page.goto("/");
    await page.getByLabel("账号").fill("e2e_accounts_admin");
    await page.getByLabel("密码", { exact: true }).fill("Accounts@123");
    await page.getByRole("button", { name: "进入 SampleFlow" }).click();
    await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();
    await expect(page.getByText("第 1 页 · 本页 50 个账号", { exact: true })).toBeVisible();

    const nextPage = page.waitForResponse((response) => new URL(response.url()).searchParams.has("cursor"));
    await page.getByRole("button", { name: "下一页" }).click();
    expect((await nextPage).status()).toBe(200);
    await expect(page.getByText("第 2 页 · 本页 7 个账号", { exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("accountPage")).toBe("1");
    expect(new URL(page.url()).searchParams.get("accountCursor")).toBeTruthy();
    await page.reload();
    await expect(page.getByText("第 2 页 · 本页 7 个账号", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "上一页" }).click();
    await expect(page.getByText("第 1 页 · 本页 50 个账号", { exact: true })).toBeVisible();

    await page.getByLabel("搜索账号").fill("e2e_role_target");
    await page.getByRole("button", { name: "搜索账号" }).click();
    await expect(page).toHaveURL(/accountSearch=e2e_role_target/);
    const targetRow = page.getByRole("row").filter({ hasText: "e2e_role_target" });
    await expect(targetRow).toBeVisible();
    let resetRequests=0;
    let releaseReset!:()=>void;
    const heldReset=new Promise<void>((resolve)=>{releaseReset=resolve;});
    await page.route(`**/api/admin/users/${targetId}/reset-password`,async(route)=>{resetRequests+=1;await heldReset;await route.abort("failed");});
    const resetButton=targetRow.getByRole("button",{name:"重置密码"});
    await resetButton.click();
    await expect(resetButton).toBeDisabled();
    await resetButton.dispatchEvent("click");
    releaseReset();
    await expect(page.getByText(/密码重置结果不确定，请勿重复操作/)).toBeVisible();
    expect(resetRequests).toBe(1);
    await page.unroute(`**/api/admin/users/${targetId}/reset-password`);
    let releaseStatus!:()=>void;
    const heldStatus=new Promise<void>((resolve)=>{releaseStatus=resolve;});
    await page.route(`**/api/admin/users/${targetId}/status`,async(route)=>{await heldStatus;await route.fulfill({status:503,contentType:"application/json",body:'{"message":"状态服务暂不可用"}'});});
    const statusButton=targetRow.getByRole("button",{name:"停用"});
    await statusButton.click();
    await expect(statusButton).toBeDisabled();
    releaseStatus();
    await expect(page.getByText("状态服务暂不可用",{exact:true})).toBeVisible();
    await expect(targetRow).toContainText("启用");
    await page.unroute(`**/api/admin/users/${targetId}/status`);
    const editRoles = targetRow.getByRole("button", { name: "修改角色" });
    await editRoles.click();
    await page.getByRole("checkbox", { name: "业务员", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "系统管理员" }).check();
    const changed = page.waitForResponse((response) => response.url().endsWith(`/api/admin/users/${targetId}/roles`) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "保存角色" }).click();
    expect((await changed).status()).toBe(200);
    await expect(targetRow).toContainText("系统管理员");
    const audit = await setup.query<{ actor_user_id: string; before_data: { roles: string[] }; after_data: { roles: string[]; result: string }; created_at: Date }>(
      `select actor_user_id::text,before_data,after_data,created_at
       from audit_logs where action='auth.account_roles_changed' and entity_id=$1 order by id desc limit 1`,
      [targetId],
    );
    expect(audit.rows[0]!.actor_user_id).toBe(adminId);
    expect(audit.rows[0]!.before_data).toEqual({ roles: ["salesperson"] });
    expect(audit.rows[0]!.after_data).toEqual({ roles: ["system_admin"], result: "succeeded" });
    expect(audit.rows[0]!.created_at).toBeTruthy();

    await editRoles.click();
    await expect(page.getByRole("dialog", { name: "修改 e2e_role_target 的角色" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "修改 e2e_role_target 的角色" })).not.toBeVisible();
    await expect(editRoles).toBeFocused();

    await page.getByLabel("搜索账号").fill("没有这个账号");
    await expect(page).toHaveURL(/accountSearch=%E6%B2%A1%E6%9C%89%E8%BF%99%E4%B8%AA%E8%B4%A6%E5%8F%B7/);
    await expect(page.getByText("没有符合条件的账号。", { exact: true })).toBeVisible();

    let failOnce = true;
    await page.route("**/api/admin/users?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("search") === "缓慢") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.continue();
      } else if (failOnce && url.searchParams.get("search") === "失败") {
        failOnce = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"账号服务暂不可用"}' });
      } else {
        await route.continue();
      }
    });
    await page.getByLabel("搜索账号").fill("缓慢");
    await page.getByRole("button", { name: "搜索账号" }).click();
    await expect(page.getByText("正在查询…", { exact: true })).toBeVisible();
    await expect(page.getByText("没有符合条件的账号。", { exact: true })).toBeVisible();

    await page.getByLabel("搜索账号").fill("e2e_role_target");
    await page.getByRole("button", { name: "搜索账号" }).click();
    await expect(targetRow).toBeVisible();
    await page.getByLabel("搜索账号").fill("失败");
    await page.getByRole("button", { name: "搜索账号" }).click();
    await expect(page.getByRole("alert")).toHaveText("账号服务暂不可用");
    await expect(targetRow).not.toBeVisible();
    await page.getByRole("button", { name: "重试查询" }).click();
    await expect(page.getByText("没有符合条件的账号。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "清除账号搜索" }).click();
    await expect(page.getByLabel("搜索账号")).toBeFocused();
    await expect(page.getByLabel("搜索账号")).toHaveValue("");
    await expect.poll(() => new URL(page.url()).searchParams.get("accountSearch")).toBe(null);
    await expect(page.getByText("第 1 页 · 本页 50 个账号", { exact: true })).toBeVisible();
  } finally {
    await setup.end();
  }
});
