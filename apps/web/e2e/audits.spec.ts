import pg from "pg";
import type { Page } from "@playwright/test";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;
test.use({ timezoneId: "America/Los_Angeles" });

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Audits@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
}

test("审计页面只读展示所属域并支持组合过滤", async ({ database, page }) => {
  const adminId = await seedTestUser(database.url, { username: "e2e_audit_admin", displayName: "E2E 审计管理员", password: "Audits@123", roleCode: "system_admin", roleName: "系统管理员" });
  await seedTestUser(database.url, { username: "e2e_audit_hr", displayName: "E2E 审计人事", password: "Audits@123", roleCode: "hr", roleName: "人事部" });
  const actorId = await seedTestUser(database.url, { username: "e2e_audit_actor", displayName: "E2E 审计业务员", password: "Audits@123", roleCode: "salesperson", roleName: "业务员" });
  const setup = new Client({ connectionString: database.url });
  await setup.connect();
  try {
    const actor = await setup.query<{ id: string }>("select id::text from people where user_id=$1", [actorId]);
    const order = await setup.query<{ id: string }>(
      `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
       values('E2E-AUDIT-1','E2E 审计客户','E2E 审计单位',$1,'E2E 审计业务员',current_date,100,100,100,'active',now()) returning id::text`,
      [actor.rows[0]!.id],
    );
    await setup.query(
      `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,department_name,group_name,created_at)
       values($1,'initial',100,100,100,date_trunc('month',current_date)::date,current_date,'E2E 审计事件',$2,'E2E 审计业务员','E2E 部门','E2E 小组','2026-09-01T12:30:30Z')`,
      [order.rows[0]!.id, actor.rows[0]!.id],
    );
    await setup.query(
      `insert into audit_logs(actor_user_id,action,entity_type,entity_id,created_at)
       select $1,'organization.pagination_fixture','org_unit',series::text,'2026-09-01T11:00:00Z'::timestamptz-series*interval '1 second'
       from generate_series(1,105) series`,
      [adminId],
    );
    await setup.query(
      `insert into audit_logs(actor_user_id,action,entity_type,entity_id,after_data,created_at) values
       ($1::bigint,'auth.account_created','user',$1::text,null,'2026-09-01T12:29:00Z'),
       ($1::bigint,'organization.unit_created','org_unit','9001',null,'2026-09-01T12:30:00Z'),
       ($2::bigint,'performance.order_posted','performance_order',$3::text,$4::jsonb,'2026-09-01T12:31:00Z')`,
      [adminId, actorId, order.rows[0]!.id, JSON.stringify({ customer: "E2E 审计客户", temporaryPassword: "E2E-TEMP-CANARY", token: "E2E-TOKEN-CANARY" })],
    );

    await login(page, "e2e_audit_admin");
    await page.getByRole("button", { name: "审计查询" }).click();
    await expect(page.getByRole("heading", { name: "审计查询" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "创建账号" })).toBeVisible();
    await expect(page.getByText("performance.order_posted", { exact: true })).not.toBeVisible();
    await page.getByRole("button", { name: "下一页" }).click();
    expect(new URL(page.url()).searchParams.get("auditCursor")).toBeTruthy();
    await expect(page.getByText("创建账号", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "组织分页记录" }).first()).toBeVisible();
    const secondPageRows = await page.locator(".audit-table tbody tr").allTextContents();
    await page.reload();
    await expect(page.getByRole("heading", { name: "审计查询" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "组织分页记录" }).first()).toBeVisible();
    expect(await page.locator(".audit-table tbody tr").allTextContents()).toEqual(secondPageRows);
    await page.goBack();
    await expect(page.getByRole("cell", { name: "创建账号" })).toBeVisible();
    await page.getByLabel("动作").fill("organization");
    await page.getByRole("button", { name: "查询审计" }).click();
    await expect(page.getByRole("cell", { name: "新增组织单元" })).toBeVisible();
    await expect(page.getByText("创建账号", { exact: true })).not.toBeVisible();
    const organizationRow = page.getByRole("row").filter({ hasText: "新增组织单元" });
    await expect(organizationRow).toContainText(/2026.*9.*1.*20:30/);
    await page.getByLabel("开始时间").fill("2026-09-01T20:00");
    const timeRequest = page.waitForRequest((request) => new URL(request.url()).searchParams.has("from"));
    await page.getByRole("button", { name: "查询审计" }).click();
    expect(new URL((await timeRequest).url()).searchParams.get("from")).toBe("2026-09-01T20:00:00+08:00");
    await expect(organizationRow).toBeVisible();
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({auditAction:"organization",auditFrom:"2026-09-01T20:00"});
    await page.reload();
    await expect(page.getByLabel("动作")).toHaveValue("organization");
    await expect(page.getByLabel("开始时间")).toHaveValue("2026-09-01T20:00");
    await expect(organizationRow).toBeVisible();
    await expect(page.locator(".audit-table").getByRole("button", { name: /修改|删除/ })).toHaveCount(0);

    await page.getByRole("button", { name: "退出登录" }).click();
    await login(page, "e2e_audit_hr");
    await page.getByRole("button", { name: "审计查询" }).click();
    await expect(page.getByRole("cell", { name: "订单入账" })).toBeVisible();
    await expect(page.getByText("创建账号", { exact: true })).not.toBeVisible();
    await expect(page.getByText("客户：E2E 审计客户", { exact: true })).toBeVisible();
    await expect(page.locator(".audit-data").filter({ hasText: /[{}]/ })).toHaveCount(0);
    await expect(page.getByText(/auth\.account_created|organization\.unit_created|performance\.order_posted/)).toHaveCount(0);
    await expect(page.getByText(/E2E-TEMP-CANARY|E2E-TOKEN-CANARY/)).toHaveCount(0);
  } finally {
    await setup.end();
  }
});
