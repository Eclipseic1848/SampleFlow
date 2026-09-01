import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

test.use({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: { width: 1280, height: 800 } });

test("桌面总览显示事件快照地区、外贸、客户单位和待补齐对账", async ({ database, page }) => {
  const userId = await seedTestUser(database.url, {
    username: "e2e_analysis_assistant",
    displayName: "E2E 分析助理",
    password: "Analysis@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });
  const client = new Client({ connectionString: database.url });
  await client.connect();
  try {
    const person = await client.query<{ id: string }>("select id::text from people where user_id=$1", [userId]);
    const order = await client.query<{ id: string }>(
      `insert into performance_orders
         (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
          salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
       values('E2E-ANALYSIS','E2E 分析客户','订单当前单位','广东当前值','CN-GD',$1,'E2E 分析助理',
              '2026-08-01',155,155,155,'active',now()) returning id::text`,
      [person.rows[0]!.id],
    );
    const events = await client.query<{ id: string }>(
      `insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
          salesperson_person_id,salesperson_name,department_name,group_name)
       values($1,'initial',100,100,100,'2026-08-01','2026-08-01','地区分析',$2,'E2E 分析助理','E2E 部','E2E 组'),
             ($1,'legacy_adjustment',-25,75,75,'2026-08-01','2026-08-02','外贸分析',$2,'E2E 分析助理','E2E 部','E2E 组'),
             ($1,'legacy_adjustment',50,125,125,'2026-08-01','2026-08-03','地区分析',$2,'E2E 分析助理','E2E 部','E2E 组'),
             ($1,'legacy_adjustment',30,155,155,'2026-08-01','2026-08-04','待补齐分析',$2,'E2E 分析助理','E2E 部','E2E 组')
       returning id::text`,
      [order.rows[0]!.id, person.rows[0]!.id],
    );
    await client.query(
      `with large_orders as (
         insert into performance_orders
           (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
            salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         select 'E2E-ANALYSIS-LARGE-'||series,'E2E 大额分析客户','大额客户','江苏来源','CN-JS',
                $1,'E2E 分析助理','2026-08-05',999999999999.99,999999999999.99,999999999999.99,'active',now()
         from generate_series(1,101) series
         returning id
       )
       insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
          salesperson_person_id,salesperson_name,department_name,group_name)
       select id,'initial',999999999999.99,999999999999.99,999999999999.99,'2026-08-01','2026-08-05','大额分币精度',
              $1,'E2E 分析助理','E2E 部','E2E 组'
       from large_orders`,
      [person.rows[0]!.id],
    );
    await client.query("set session_replication_role=replica");
    await client.query("delete from performance_event_analysis_dimensions where event_id=any($1::bigint[])", [events.rows.map((row) => row.id)]);
    await client.query(
      `insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit)
       values($1,'CN-JS','江苏来源','客户单位甲'),($2,'EXT-TRADE','外贸','客户单位乙'),($3,'CN-ZJ','浙江来源','客户单位甲')`,
      [events.rows[0]!.id, events.rows[1]!.id, events.rows[2]!.id],
    );
    await client.query("set session_replication_role=origin");
  } finally {
    await client.end();
  }

  await page.goto("/");
  await page.getByLabel("账号").fill("e2e_analysis_assistant");
  await page.getByLabel("密码", { exact: true }).fill("Analysis@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();

  const analysis = page.getByRole("region", { name: "地区与客户单位分析" });
  await analysis.getByLabel("分析月份").fill("2026-08");
  await expect(analysis.getByText("已映射金额 + 待补齐金额与授权范围总账完全对平。", { exact: true })).toBeVisible();
  await expect(analysis.getByText("¥101,000,000,000,153.99", { exact: true })).toBeVisible();
  await expect(analysis.getByText("¥101,000,000,000,123.99", { exact: true })).toBeVisible();
  await expect(analysis.getByText("¥30.00", { exact: true })).toBeVisible();

  const provinces = analysis.getByRole("table", { name: "省份汇总" });
  await expect(provinces.getByRole("row", { name: /江苏省.*102.*¥101,000,000,000,098\.99/ })).toBeVisible();
  await expect(provinces.getByRole("row", { name: /浙江省.*1.*¥50\.00/ })).toBeVisible();
  await expect(provinces.getByText("外贸", { exact: true })).toHaveCount(0);
  await expect(analysis.getByText("外贸（EXT-TRADE）", { exact: true })).toBeVisible();
  await expect(analysis.getByText("1 条事件 · -¥25.00", { exact: true })).toBeVisible();

  const customers = analysis.getByRole("table", { name: "客户单位汇总" });
  await expect(customers.getByRole("row", { name: /江苏省.*客户单位甲.*1.*¥100\.00/ })).toBeVisible();
  await expect(customers.getByRole("row", { name: /江苏省.*大额客户.*101.*¥100,999,999,999,998\.99/ })).toBeVisible();
  await expect(customers.getByRole("row", { name: /外贸.*客户单位乙.*1.*-¥25\.00/ })).toBeVisible();

  let releaseResponse!: () => void;
  let markRequested!: () => void;
  const heldResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const requestStarted = new Promise<void>((resolve) => { markRequested = resolve; });
  await page.route("**/api/performance/analysis?month=2026-09", async (route) => {
    markRequested();
    await heldResponse;
    await route.continue();
  });
  await analysis.getByLabel("分析月份").fill("2026-09");
  await requestStarted;
  try {
    await expect(analysis.getByRole("status")).toHaveText("正在读取地区与客户单位分析…");
    await expect(analysis.getByText("¥101,000,000,000,153.99", { exact: true })).toHaveCount(0);
  } finally {
    releaseResponse();
  }
  await expect(analysis.locator(".metric").filter({ hasText: "授权范围总账" }).getByText("¥0.00", { exact: true })).toBeVisible();
});
