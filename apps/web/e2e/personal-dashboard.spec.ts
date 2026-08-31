import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function shiftMonth(periodMonth: string, offset: number): string {
  const [year, month] = periodMonth.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

test.use({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: { width: 1024, height: 768 } });

test("业务员默认查看当前月个人目标并穿透正负业绩事件", async ({ database, page }) => {
  const today = shanghaiToday();
  const periodMonth = today.slice(0, 7);
  const seeded = new Map<string, { target: number; actual: number; rate: string }>();
  const userId = await seedTestUser(database.url, {
    username: "e2e_personal_dashboard",
    displayName: "E2E 个人看板业务员",
    password: "Dashboard@123",
    roleCode: "salesperson",
    roleName: "业务员",
  });
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    const person = await client.query<{ id: string }>("select id::text from people where user_id=$1", [userId]);
    const personId = person.rows[0]!.id;
    for (const [offset, month] of [-1, 0, 1].map((offset) => [offset, shiftMonth(periodMonth, offset)] as const)) {
      const target = 1000 + offset * 100;
      const actual = target - 250;
      seeded.set(month, { target, actual, rate: (actual * 100 / target).toFixed(2) });
      const goal = await client.query<{ id: string }>(
        `insert into goals(period_month,goal_level,owner_user_id,owner_person_id)
         values($1,'personal',$2,$3) returning id::text`,
        [`${month}-01`, userId, personId],
      );
      await client.query(
        `insert into goal_versions(goal_id,version_no,amount,status,created_by,created_by_person_id,change_reason)
         values($1,1,$2,'active',$3,$4,'E2E 个人目标')`,
        [goal.rows[0]!.id, target, userId, personId],
      );
      const order = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values($1,'E2E 看板客户','E2E 看板单位',$2,'E2E 个人看板业务员',
                $3,$4,$5,$5,'active',now()) returning id::text`,
        [`P1-PERSONAL-${month}`, personId, `${month}-01`, target, actual],
      );
      await client.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,
           department_name,group_name,leader_name,supervisor_name)
         values($1,'initial',$5,$5,$5,$2,$3,'首次计入',$4,'E2E 个人看板业务员',
                'E2E 看板部','E2E 看板组','E2E 看板组长','E2E 看板主管'),
               ($1,'revenue_change',-250,$6,$6,$2,$3,'金额调减',$4,'E2E 个人看板业务员',
                'E2E 看板部','E2E 看板组','E2E 看板组长','E2E 看板主管')`,
        [order.rows[0]!.id, `${month}-01`, `${month}-01`, personId, target, actual],
      );
    }
  } finally {
    await client.end();
  }

  await page.goto("/");
  await page.getByLabel("账号").fill("e2e_personal_dashboard");
  await page.getByLabel("密码", { exact: true }).fill("Dashboard@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();

  await expect(page.getByRole("heading", { name: "业绩账本总览" })).toBeVisible();
  const subtitle = page.locator(".dashboard > header p");
  await expect(subtitle).toContainText("个人目标与不可变业绩事件");
  const selected = (await subtitle.textContent())?.match(/(\d{4}) 年 (\d{2}) 月/)?.slice(1).join("-");
  expect(selected).toBeTruthy();
  expect([periodMonth, shanghaiToday().slice(0, 7)]).toContain(selected);
  const expected = seeded.get(selected!);
  expect(expected).toBeTruthy();
  const personal = page.getByRole("region", { name: "个人目标达成" });
  await expect(personal.getByText(`¥${expected!.target.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, { exact: true })).toBeVisible();
  await expect(personal.getByText("¥250.00", { exact: true })).toBeVisible();
  await expect(personal.getByText(`${expected!.rate}%`, { exact: true })).toBeVisible();
  const currentDate = shanghaiToday();
  const currentMonth = currentDate.slice(0, 7);
  const progress = selected! < currentMonth ? 100 : Number((Number(currentDate.slice(8, 10)) / new Date(Number(currentDate.slice(0, 4)), Number(currentDate.slice(5, 7)), 0).getDate() * 100).toFixed(2));
  await expect(personal.locator(".metric").filter({ hasText: "自然日进度" }).getByText(`${progress.toFixed(2)}%`, { exact: true })).toBeVisible();
  await expect(personal.locator(".metric").filter({ hasText: "进度偏差" }).getByText(`${(Number(expected!.rate)-progress).toFixed(2)}%`, { exact: true })).toBeVisible();
  const actual = personal.getByRole("button", { name: "查看个人业绩构成" });
  await expect(actual).toHaveText(`¥${expected!.actual.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  await actual.click();

  const details = page.getByRole("dialog", { name: "个人业绩构成" });
  await expect(details.getByText(`2 条事件 · 净额 ¥${expected!.actual.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, { exact: true })).toBeVisible();
  await expect(details.getByText(`P1-PERSONAL-${selected}`, { exact: true })).toHaveCount(2);
  await expect(details.getByText(`正向 ¥${expected!.target.toLocaleString("en-US", { minimumFractionDigits: 2 })}`, { exact: true })).toBeVisible();
  await expect(details.getByText("负向 ¥250.00", { exact: true })).toBeVisible();
  await expect(details.getByText("分析维度待补齐", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "关闭" }).click();
  await personal.getByRole("button", { name: "查看个人差距构成" }).click();
  const gap = page.getByRole("dialog", { name: "个人差距构成" });
  await expect(gap.getByText(`目标 ¥${expected!.target.toLocaleString("en-US", { minimumFractionDigits: 2 })} − 事件净额 ¥${expected!.actual.toLocaleString("en-US", { minimumFractionDigits: 2 })} = 差距 ¥250.00`, { exact: true })).toBeVisible();
});
