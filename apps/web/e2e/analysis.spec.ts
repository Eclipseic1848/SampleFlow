import pg from "pg";
import { seedTestUser } from "../../api/src/test-support/fixtures.js";
import { expect, test } from "./full-stack.js";

const { Client } = pg;

test("业绩分析页显示事件快照地区、外贸、客户单位和待补齐对账", async ({ database, page }) => {
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
              '2026-08-01',155,162,162,'active',now()) returning id::text`,
      [person.rows[0]!.id],
    );
    const events = await client.query<{ id: string }>(
      `insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
          salesperson_person_id,salesperson_name,department_name,group_name)
       values($1,'initial',100,100,100,'2026-08-01','2026-08-01','地区分析',$2,'E2E 分析助理','E2E 部','E2E 组'),
             ($1,'legacy_adjustment',-25,75,75,'2026-08-01','2026-08-02','外贸分析',$2,'E2E 分析助理','E2E 部','E2E 组'),
             ($1,'legacy_adjustment',50,125,125,'2026-08-01','2026-08-03','地区分析',$2,'E2E 分析助理','E2E 部','E2E 组'),
             ($1,'legacy_adjustment',30,155,155,'2026-08-01','2026-08-04','待补齐分析',$2,'E2E 分析助理','E2E 部','E2E 组'),
             ($1,'legacy_adjustment',7,162,162,'2026-09-01','2026-09-01','月份穿透',$2,'E2E 分析助理','E2E 部','E2E 组')
       returning id::text`,
      [order.rows[0]!.id, person.rows[0]!.id],
    );
    const taiwanOrder=await client.query<{id:string}>(
      `insert into performance_orders
         (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
          salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
       values('E2E-ANALYSIS-TW','E2E 台湾客户','台湾客户单位','台湾省','CN-TW',$1,'E2E 分析助理',
              '2026-08-06',10,10,10,'active',now()) returning id::text`,
      [person.rows[0]!.id],
    );
    await client.query(
      `insert into performance_events
         (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
          salesperson_person_id,salesperson_name,department_name,group_name)
       values($1,'initial',10,10,10,'2026-08-01','2026-08-06','台湾省分析',$2,'E2E 分析助理','E2E 部','E2E 组')`,
      [taiwanOrder.rows[0]!.id,person.rows[0]!.id],
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
       values($1,'CN-JS','江苏来源','客户单位甲'),($2,'EXT-TRADE','外贸','客户单位乙'),
             ($3,'CN-ZJ','浙江来源','客户单位甲'),($4,'CN-JS','江苏来源','客户单位甲')`,
      [events.rows[0]!.id, events.rows[1]!.id, events.rows[2]!.id, events.rows[4]!.id],
    );
    await client.query("set session_replication_role=origin");
  } finally {
    await client.end();
  }

  await page.goto("/");
  await page.getByLabel("账号").fill("e2e_analysis_assistant");
  await page.getByLabel("密码", { exact: true }).fill("Analysis@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
  await page.getByRole("button", { name: "业绩分析" }).click();

  const analysis = page.getByRole("region", { name: "地区与客户单位分析" });
  await analysis.getByLabel("分析月份").fill("2026-08");
  await expect(analysis.getByText("已映射金额 + 待补齐金额与授权范围总账完全对平。", { exact: true })).toBeVisible();
  await expect(analysis.getByText("¥101,000,000,000,163.99", { exact: true })).toBeVisible();
  await expect(analysis.getByText("¥101,000,000,000,133.99", { exact: true })).toBeVisible();
  await expect(analysis.getByText("¥30.00", { exact: true })).toBeVisible();

  const provinces = analysis.getByRole("table", { name: "省份汇总" });
  await expect(provinces.getByRole("row", { name: /江苏省.*102.*¥101,000,000,000,098\.99/ })).toBeVisible();
  await expect(provinces.getByRole("row", { name: /浙江省.*1.*¥50\.00/ })).toBeVisible();
  await expect(provinces.getByRole("row", { name: /CN-TW.*1.*¥10\.00/ })).toBeVisible();
  await expect(provinces.getByText("外贸", { exact: true })).toHaveCount(0);
  await expect(analysis.getByText("外贸（EXT-TRADE）", { exact: true })).toBeVisible();
  await expect(analysis.getByText("1 条事件 · -¥25.00", { exact: true })).toBeVisible();

  const customers = analysis.getByRole("table", { name: "客户单位汇总" });
  await expect(customers.getByRole("row", { name: /江苏省.*客户单位甲.*1.*¥100\.00/ })).toBeVisible();
  await expect(customers.getByRole("row", { name: /江苏省.*大额客户.*101.*¥100,999,999,999,998\.99/ })).toBeVisible();
  await expect(customers.getByRole("row", { name: /外贸.*客户单位乙.*1.*-¥25\.00/ })).toBeVisible();

  const map = analysis.getByRole("group", { name: "中国省份业绩地图" });
  const mapRegionCodes = await map.locator("[data-region-code]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-region-code")).sort());
  expect(mapRegionCodes).toEqual([
    "CN-AH", "CN-BJ", "CN-CQ", "CN-FJ", "CN-GD", "CN-GS", "CN-GX", "CN-GZ", "CN-HA", "CN-HB", "CN-HE", "CN-HI",
    "CN-HK", "CN-HL", "CN-HN", "CN-JL", "CN-JS", "CN-JX", "CN-LN", "CN-MO", "CN-NM", "CN-NX", "CN-QH", "CN-SC",
    "CN-SD", "CN-SH", "CN-SN", "CN-SX", "CN-TJ", "CN-TW", "CN-XJ", "CN-XZ", "CN-YN", "CN-ZJ",
  ]);
  await expect(map.locator('[data-region-code="CN-TW"]')).toBeVisible();
  await expect(map.locator(".analysis-map-boundary")).toHaveCount(0);
  const southernEdge = await map.locator("[data-region-code]").evaluateAll((elements) => Math.max(...elements.map((element) => { const box = (element as SVGGraphicsElement).getBBox(); return box.y + box.height; })));
  expect(southernEdge).toBeLessThanOrEqual(608.01);
  await expect(analysis.getByText("台湾省 1 条事件 · ¥10.00", { exact: true })).toBeVisible();
  const jiangsu = map.getByRole("button", { name: "地图选择江苏省，102 条事件，金额 ¥101,000,000,000,098.99" });
  const zhejiang = map.getByRole("button", { name: "地图选择浙江省，1 条事件，金额 ¥50.00" });
  await expect(jiangsu).toBeVisible();
  await page.route("**/api/performance/analysis/drilldown?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("level") !== "customers" || url.searchParams.get("regionCode") !== "CN-JS") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, eventCount: body.eventCount + 1 } });
  });
  await jiangsu.click();
  const drilldown = analysis.getByRole("region", { name: "分析穿透" });
  await expect(drilldown.getByRole("heading", { name: "江苏省客户单位" })).toBeVisible();
  await expect(drilldown.getByText("客户合计与省份汇总不一致，请停止使用当前穿透结果。", { exact: true })).toBeVisible();
  await page.unroute("**/api/performance/analysis/drilldown?*");
  await zhejiang.click();
  await expect(analysis.getByRole("region", { name: "分析穿透" }).getByRole("heading", { name: "浙江省客户单位" })).toBeVisible();
  await jiangsu.click();
  await expect(drilldown.getByRole("heading", { name: "江苏省客户单位" })).toBeVisible();
  await expect(drilldown.getByText("¥101,000,000,000,098.99", { exact: true })).toBeVisible();
  await drilldown.getByRole("button", { name: "查看客户单位甲月份趋势" }).click();
  await expect(drilldown.getByRole("heading", { name: "客户单位甲月度趋势" })).toBeVisible();
  await expect(drilldown.getByRole("button", { name: "查看2026年8月订单事件，1 条事件，金额 ¥100.00" })).toBeVisible();
  await expect(drilldown.getByRole("button", { name: "查看2026年9月订单事件，1 条事件，金额 ¥7.00" })).toBeVisible();
  await drilldown.getByRole("button", { name: "查看2026年8月订单事件，1 条事件，金额 ¥100.00" }).click();
  await expect(drilldown.getByRole("heading", { name: "2026年8月订单与事件" })).toBeVisible();
  await expect(drilldown.getByRole("row", { name: /E2E-ANALYSIS.*E2E 分析客户.*1.*¥100\.00/ })).toBeVisible();
  await expect(drilldown.getByRole("row", { name: /第 1 条.*首次录入.*¥100\.00.*江苏省.*客户单位甲/ })).toBeVisible();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({analysisMonth:"2026-08",analysisRegion:"CN-JS",analysisCustomer:"客户单位甲",analysisEventMonth:"2026-08"});
  await page.reload();
  await expect(analysis.getByRole("region", { name: "分析穿透" }).getByRole("heading", { name: "2026年8月订单与事件" })).toBeVisible();

  let failSeptemberEvents = true;
  await page.route("**/api/performance/analysis/drilldown?*", async (route) => {
    const url = new URL(route.request().url());
    if (failSeptemberEvents && url.searchParams.get("level") === "events" && url.searchParams.get("month") === "2026-09") {
      failSeptemberEvents = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "穿透服务暂不可用" }) });
      return;
    }
    await route.continue();
  });
  await drilldown.getByRole("button", { name: "查看2026年9月订单事件，1 条事件，金额 ¥7.00" }).click();
  await expect(drilldown.getByRole("alert")).toHaveText("穿透服务暂不可用");
  await drilldown.getByRole("button", { name: "重试订单事件" }).click();
  await expect(drilldown.getByRole("row", { name: /E2E-ANALYSIS.*E2E 分析客户.*1.*¥7\.00/ })).toBeVisible();
  await page.unroute("**/api/performance/analysis/drilldown?*");

  await drilldown.getByRole("button", { name: "查看大额客户月份趋势" }).click();
  await drilldown.getByRole("button", { name: "查看2026年8月订单事件，101 条事件，金额 ¥100,999,999,999,998.99" }).click();
  await expect(drilldown.getByText("已加载 100 / 101 条事件", { exact: true })).toBeVisible();
  await drilldown.getByRole("button", { name: "加载更多事件" }).click();
  await expect(drilldown.getByText("已加载 101 / 101 条事件", { exact: true })).toBeVisible();
  await expect(drilldown.getByRole("button", { name: "加载更多事件" })).toHaveCount(0);

  await drilldown.getByRole("button", { name: "查看2026年1月订单事件，0 条事件，金额 ¥0.00" }).click();
  await expect(drilldown.getByText("该月份没有订单事件。", { exact: true })).toBeVisible();
  await zhejiang.focus();
  await page.keyboard.press("Enter");
  await expect(analysis.getByRole("region", { name: "分析穿透" }).getByRole("heading", { name: "浙江省客户单位" })).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(map).toBeVisible();

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
    await expect(analysis.getByText("¥101,000,000,000,163.99", { exact: true })).toHaveCount(0);
  } finally {
    releaseResponse();
  }
  await expect(analysis.locator(".metric").filter({ hasText: "授权范围总账" }).getByText("¥7.00", { exact: true })).toBeVisible();
});

test("第二批客户穿透可通过刷新和浏览器历史恢复", async ({ database, page }) => {
  await seedTestUser(database.url, {
    username: "e2e_analysis_restore",
    displayName: "E2E 分析恢复",
    password: "Analysis@123",
    roleCode: "sales_assistant",
    roleName: "销售助理",
  });
  await page.route("**/api/performance/analysis?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      month: "2026-08",
      ledger: { eventCount: 0, totalAmount: "0.00" },
      mapped: { eventCount: 0, totalAmount: "0.00" },
      pending: { eventCount: 0, totalAmount: "0.00" },
      reconciled: true,
      provinces: [{ regionCode: "CN-JS", regionName: "江苏省", eventCount: 0, totalAmount: "0.00" }],
      foreignTrade: { regionCode: "EXT-TRADE", regionName: "外贸", eventCount: 0, totalAmount: "0.00" },
      customers: [],
    }) });
  });
  let customerRequests = 0;
  await page.route("**/api/performance/analysis/drilldown?*", async (route) => {
    const url = new URL(route.request().url());
    const level = url.searchParams.get("level");
    if (level === "customers") {
      customerRequests += 1;
      const secondPage = url.searchParams.get("cursor") === "page-2";
      const customers = secondPage
        ? [{ customerUnit: "客户51", eventCount: 0, totalAmount: "0.00" }]
        : Array.from({ length: 50 }, (_, index) => ({ customerUnit: `客户${String(index + 1).padStart(2, "0")}`, eventCount: 0, totalAmount: "0.00" }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ level, regionCode: "CN-JS", regionName: "江苏省", month: "2026-08", eventCount: 0, totalAmount: "0.00", customerCount: 51, nextCursor: secondPage ? null : "page-2", pageSize: 50, customers }) });
      return;
    }
    if (level === "months") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ level, regionCode: "CN-JS", regionName: "江苏省", customerUnit: url.searchParams.get("customerUnit"), year: "2026", eventCount: 0, totalAmount: "0.00", months: [{ month: "2026-08", eventCount: 0, totalAmount: "0.00" }] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ level: "events", regionCode: "CN-JS", regionName: "江苏省", customerUnit: url.searchParams.get("customerUnit"), month: "2026-08", eventCount: 0, totalAmount: "0.00", nextCursor: null, pageSize: 100, orders: [] }) });
  });

  await page.goto(`/?${new URLSearchParams({ page: "analysis", analysisMonth: "2026-08", analysisRegion: "CN-JS", analysisCustomer: "客户51", analysisEventMonth: "2026-08" })}`);
  await page.getByLabel("账号").fill("e2e_analysis_restore");
  await page.getByLabel("密码", { exact: true }).fill("Analysis@123");
  await page.getByRole("button", { name: "进入 SampleFlow" }).click();
  await expect(page.getByText("台湾省资料暂缺", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "客户51月度趋势" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "2026年8月订单与事件" })).toBeVisible();
  expect(customerRequests).toBeGreaterThanOrEqual(2);

  customerRequests = 0;
  await page.reload();
  await expect(page.getByRole("heading", { name: "2026年8月订单与事件" })).toBeVisible();
  expect(customerRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "查看客户01月份趋势" }).click();
  await expect(page.getByRole("heading", { name: "客户01月度趋势" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "2026年8月订单与事件" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "客户01月度趋势" })).toBeVisible();
});
