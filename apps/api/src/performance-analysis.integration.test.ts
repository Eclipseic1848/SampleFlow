import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "./app.js";
import { seedTestUser } from "./test-support/fixtures.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client, Pool } = pg;
const TEST_ORIGIN = "http://127.0.0.1:4174";
type CapturedQuery = { statement: string; values: unknown[] };

function requireCapturedQuery(value: CapturedQuery | null): CapturedQuery {
  if (!value) throw new Error("未捕获地区与客户分析 SQL");
  return value;
}

function assertNoPerRowAnalysisScan(plan: Record<string, unknown>, baseline: string): void {
  const repeatedNodes: Array<Record<string, unknown>> = [];
  const visit = (node: Record<string, unknown>) => {
    const relation = String(node["Relation Name"] ?? "");
    const loops = Number(node["Actual Loops"] ?? 0);
    const boundedDimensionLookup = relation === "performance_event_analysis_dimensions"
      && node["Node Type"] === "Index Scan"
      && node["Index Name"] === "performance_event_analysis_dimensions_pkey"
      && Number(node["Actual Rows"] ?? 0) <= 1;
    const boundedOrderLookup = relation === "performance_orders"
      && node["Node Type"] === "Index Scan"
      && node["Index Name"] === "performance_orders_pkey"
      && Number(node["Actual Rows"] ?? 0) <= 1;
    if (loops > 1 && (node["Parent Relationship"] === "SubPlan" || relation === "performance_events" || (relation === "performance_event_analysis_dimensions" && !boundedDimensionLookup) || (relation === "performance_orders" && !boundedOrderLookup))) repeatedNodes.push(node);
    for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) visit(child);
  };
  visit(plan);
  assert.deepEqual(repeatedNodes, [], `${baseline}分析查询不得逐输出行重复扫描事件或维度`);
}

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>, username: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: TEST_ORIGIN },
    payload: { username, password: "Role@123" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookies = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"].map(String)
    : [String(response.headers["set-cookie"])];
  return setCookies.map((value) => value.split(";", 1)[0]).join("; ");
}

test("地区与客户分析按事件快照对账且查询次数不随规模增长", async () => {
  await withMigratedTestDatabase(async (database) => {
    const leaderUserId = await seedTestUser(database.url, { username: "analysis_leader", displayName: "分析组长", password: "Role@123", roleCode: "sales_leader", roleName: "业务员组长" });
    const aliceUserId = await seedTestUser(database.url, { username: "analysis_alice", displayName: "分析业务员", password: "Role@123", roleCode: "salesperson", roleName: "业务员" });
    const bobUserId = await seedTestUser(database.url, { username: "analysis_bob", displayName: "范围外业务员", password: "Role@123", roleCode: "salesperson", roleName: "业务员" });
    await seedTestUser(database.url, { username: "analysis_admin", displayName: "纯系统管理员", password: "Role@123", roleCode: "system_admin", roleName: "系统管理员" });

    const setup = new Client({ connectionString: database.url });
    await setup.connect();
    try {
      const people = await setup.query<{ user_id: string; person_id: string }>(
        "select user_id::text,p.id::text as person_id from people p where user_id=any($1::bigint[])",
        [[leaderUserId, aliceUserId, bobUserId]],
      );
      const personByUser = Object.fromEntries(people.rows.map((row) => [row.user_id, row.person_id]));
      const leaderPersonId = personByUser[leaderUserId]!;
      const alicePersonId = personByUser[aliceUserId]!;
      const bobPersonId = personByUser[bobUserId]!;
      const departmentA = await setup.query<{ id: string }>("insert into org_units(name,unit_type) values('分析甲部','department') returning id::text");
      const departmentB = await setup.query<{ id: string }>("insert into org_units(name,unit_type) values('分析乙部','department') returning id::text");
      const groupA = await setup.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('分析甲组','group',$1) returning id::text", [departmentA.rows[0]!.id]);
      const groupB = await setup.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('分析乙组','group',$1) returning id::text", [departmentB.rows[0]!.id]);
      await setup.query(
        `insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from)
         values($1,$2,'leader','2026-01-01')`,
        [leaderPersonId, groupA.rows[0]!.id],
      );
      const order = await setup.query<{ id: string }>(
        `insert into performance_orders
           (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
            salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('ANALYSIS-CROSS','跨维度客户','订单当前单位','广东当前值','CN-GD',$1,'分析业务员','2026-08-01',155,155,155,'active',now())
         returning id::text`,
        [alicePersonId],
      );
      const outOfScopeOrder = await setup.query<{ id: string }>(
        `insert into performance_orders
           (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
            salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('ANALYSIS-OUT','范围外客户','范围外单位','范围外地区','CN-BJ',$1,'范围外业务员','2026-08-01',999,999,999,'active',now())
         returning id::text`,
        [bobPersonId],
      );

      async function insertEvent(orderId: string, amount: number, month: string, salespersonPersonId: string, departmentId: string, departmentName: string, groupId: string, groupName: string) {
        return (await setup.query<{ id: string }>(
          `insert into performance_events
             (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
              salesperson_person_id,salesperson_name,department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name)
           values($1,'legacy_adjustment',$2,155,155,$3::date,$3::date,'分析回归',$4,$5,$6,$7,$8,$9,$10,'分析组长')
           returning id::text`,
          [orderId, amount, month, salespersonPersonId, salespersonPersonId === bobPersonId ? "范围外业务员" : "分析业务员", departmentId, departmentName, groupId, groupName, leaderPersonId],
        )).rows[0]!.id;
      }

      const eventIds = [
        await insertEvent(order.rows[0]!.id, 100, "2026-08-01", alicePersonId, departmentA.rows[0]!.id, "分析甲部", groupA.rows[0]!.id, "分析甲组"),
        await insertEvent(order.rows[0]!.id, -25, "2026-08-01", alicePersonId, departmentA.rows[0]!.id, "分析甲部", groupA.rows[0]!.id, "分析甲组"),
        await insertEvent(order.rows[0]!.id, 50, "2026-08-01", alicePersonId, departmentA.rows[0]!.id, "分析甲部", groupA.rows[0]!.id, "分析甲组"),
        await insertEvent(order.rows[0]!.id, 0, "2026-08-01", alicePersonId, departmentA.rows[0]!.id, "分析甲部", groupA.rows[0]!.id, "分析甲组"),
        await insertEvent(order.rows[0]!.id, 30, "2026-08-01", alicePersonId, departmentA.rows[0]!.id, "分析甲部", groupA.rows[0]!.id, "分析甲组"),
        await insertEvent(order.rows[0]!.id, 7, "2026-09-01", alicePersonId, departmentA.rows[0]!.id, "分析甲部", groupA.rows[0]!.id, "分析甲组"),
      ];
      const outOfScopeEventId = await insertEvent(outOfScopeOrder.rows[0]!.id, 999, "2026-08-01", bobPersonId, departmentB.rows[0]!.id, "分析乙部", groupB.rows[0]!.id, "分析乙组");

      await setup.query("set session_replication_role=replica");
      await setup.query("delete from performance_event_analysis_dimensions where event_id=any($1::bigint[])", [[...eventIds, outOfScopeEventId]]);
      await setup.query(
        `insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit)
         values($1,'CN-JS','江苏来源','客户单位甲'),($2,'EXT-TRADE','外贸','客户单位乙'),
               ($3,'CN-ZJ','浙江来源','客户单位甲'),($4,'CN-JS','江苏来源','客户单位甲'),
               ($5,'CN-JS','江苏来源','客户单位甲'),($6,'CN-BJ','北京来源','范围外单位')`,
        [eventIds[0], eventIds[1], eventIds[2], eventIds[3], eventIds[5], outOfScopeEventId],
      );
      await setup.query("set session_replication_role=origin");
      await setup.query("update performance_orders set customer_unit='已变更当前单位',business_region_code='CN-GD',business_region_source_text='广东当前值' where id=$1", [order.rows[0]!.id]);

      const runtimeUrl = new URL(database.url);
      runtimeUrl.searchParams.set("application_name", "sampleflow-api-runtime");
      const pool = new Pool({ connectionString: runtimeUrl.toString() });
      let analysisReadCount = 0;
      let analysisShareLockCount = 0;
      let analysisQuery: CapturedQuery | null = null;
      const patched = new WeakSet<pg.PoolClient>();
      pool.on("acquire", (client) => {
        if (patched.has(client)) return;
        patched.add(client);
        const originalQuery = client.query.bind(client);
        client.query = ((...args: unknown[]) => {
          const statement = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
          if (/^\s*(select|with)\b/i.test(statement) && !/\bfrom sessions\b/i.test(statement)) analysisReadCount += 1;
          if (/^\s*lock table performance_event_analysis_dimensions in share mode\s*$/i.test(statement)) analysisShareLockCount += 1;
          if (/scoped_analysis as materialized/i.test(statement)) {
            const values = typeof args[0] === "string" ? args[1] : (args[0] as { values?: unknown[] }).values;
            analysisQuery = { statement, values: Array.isArray(values) ? [...values] : [] };
          }
          return originalQuery(...args as [string, unknown[]]);
        }) as typeof client.query;
      });
      const app = await buildApp({ database: pool, logger: false });
      try {
        const leaderCookie = await loginCookie(app, "analysis_leader");
        analysisReadCount = 0;
        const response = await app.inject({ method: "GET", url: "/api/performance/analysis?month=2026-08", headers: { cookie: leaderCookie } });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json();
        assert.deepEqual(body.ledger, { eventCount: 5, totalAmount: "155.00" });
        assert.deepEqual(body.mapped, { eventCount: 4, totalAmount: "125.00" });
        assert.deepEqual(body.pending, { eventCount: 1, totalAmount: "30.00" });
        assert.equal(body.reconciled, true);
        assert.deepEqual(body.provinces, [
          { regionCode: "CN-JS", regionName: "江苏省", eventCount: 2, totalAmount: "100.00" },
          { regionCode: "CN-ZJ", regionName: "浙江省", eventCount: 1, totalAmount: "50.00" },
        ]);
        assert.deepEqual(body.foreignTrade, { regionCode: "EXT-TRADE", regionName: "外贸", eventCount: 1, totalAmount: "-25.00" });
        assert.ok(body.provinces.every((item: { regionCode: string }) => item.regionCode !== "EXT-TRADE"));
        assert.deepEqual(body.customers, [
          { regionCode: "CN-JS", regionName: "江苏省", customerUnit: "客户单位甲", eventCount: 2, totalAmount: "100.00" },
          { regionCode: "CN-ZJ", regionName: "浙江省", customerUnit: "客户单位甲", eventCount: 1, totalAmount: "50.00" },
          { regionCode: "EXT-TRADE", regionName: "外贸", customerUnit: "客户单位乙", eventCount: 1, totalAmount: "-25.00" },
        ]);
        assert.ok(analysisReadCount <= 4, `分析请求数据库读取应不超过 4 次，实际 ${analysisReadCount} 次`);
        const smallReadCount = analysisReadCount;
        const capturedAnalysisQuery = requireCapturedQuery(analysisQuery);
        assert.doesNotMatch(capturedAnalysisQuery.statement, /performance_orders/i);
        const smallExplain = await setup.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
          `explain (analyze,format json) ${capturedAnalysisQuery.statement}`,
          capturedAnalysisQuery.values,
        );
        assertNoPerRowAnalysisScan(smallExplain.rows[0]!["QUERY PLAN"][0]!.Plan, "小基线");

        analysisReadCount = 0;
        const customers = await app.inject({
          method: "GET",
          url: "/api/performance/analysis/drilldown?level=customers&regionCode=CN-JS&month=2026-08",
          headers: { cookie: leaderCookie },
        });
        assert.equal(customers.statusCode, 200, customers.body);
        assert.deepEqual(customers.json(), {
          level: "customers",
          regionCode: "CN-JS",
          regionName: "江苏省",
          month: "2026-08",
          eventCount: 2,
          totalAmount: "100.00",
          customerCount: 1,
          nextCursor: null,
          pageSize: 50,
          customers: [{ customerUnit: "客户单位甲", eventCount: 2, totalAmount: "100.00" }],
        });
        assert.ok(analysisReadCount <= 3, `省份客户穿透读取应不超过 3 次，实际 ${analysisReadCount} 次`);
        const smallCustomersReadCount = analysisReadCount;
        const smallCustomersQuery = requireCapturedQuery(analysisQuery);

        analysisReadCount = 0;
        const months = await app.inject({
          method: "GET",
          url: "/api/performance/analysis/drilldown?level=months&regionCode=CN-JS&customerUnit=%E5%AE%A2%E6%88%B7%E5%8D%95%E4%BD%8D%E7%94%B2&year=2026",
          headers: { cookie: leaderCookie },
        });
        assert.equal(months.statusCode, 200, months.body);
        assert.deepEqual(months.json(), {
          level: "months",
          regionCode: "CN-JS",
          regionName: "江苏省",
          customerUnit: "客户单位甲",
          year: "2026",
          eventCount: 3,
          totalAmount: "107.00",
          months: [
            { month: "2026-08", eventCount: 2, totalAmount: "100.00" },
            { month: "2026-09", eventCount: 1, totalAmount: "7.00" },
          ],
        });
        assert.ok(analysisReadCount <= 3, `客户月份穿透读取应不超过 3 次，实际 ${analysisReadCount} 次`);
        const smallMonthsReadCount = analysisReadCount;
        const smallMonthsQuery = requireCapturedQuery(analysisQuery);

        analysisReadCount = 0;
        const events = await app.inject({
          method: "GET",
          url: "/api/performance/analysis/drilldown?level=events&regionCode=CN-JS&customerUnit=%E5%AE%A2%E6%88%B7%E5%8D%95%E4%BD%8D%E7%94%B2&month=2026-08",
          headers: { cookie: leaderCookie },
        });
        assert.equal(events.statusCode, 200, events.body);
        const eventsBody = events.json();
        assert.deepEqual({
          level: eventsBody.level,
          regionCode: eventsBody.regionCode,
          regionName: eventsBody.regionName,
          customerUnit: eventsBody.customerUnit,
          month: eventsBody.month,
          eventCount: eventsBody.eventCount,
          totalAmount: eventsBody.totalAmount,
          nextCursor: eventsBody.nextCursor,
          pageSize: eventsBody.pageSize,
        }, {
          level: "events",
          regionCode: "CN-JS",
          regionName: "江苏省",
          customerUnit: "客户单位甲",
          month: "2026-08",
          eventCount: 2,
          totalAmount: "100.00",
          nextCursor: null,
          pageSize: 100,
        });
        assert.deepEqual(eventsBody.orders.map((item: Record<string, unknown>) => ({ ...item, events: undefined })), [{
          orderId: order.rows[0]!.id,
          orderNo: "ANALYSIS-CROSS",
          customerName: "跨维度客户",
          eventCount: 2,
          totalAmount: "100.00",
          events: undefined,
        }]);
        assert.deepEqual(eventsBody.orders[0].events.map((item: Record<string, unknown>) => ({
          id: item.id,
          sequence: item.sequence,
          eventType: item.eventType,
          deltaAmount: item.deltaAmount,
          accountingMonth: item.accountingMonth,
          occurredOn: item.occurredOn,
          reason: item.reason,
          salespersonName: item.salespersonName,
          departmentName: item.departmentName,
          groupName: item.groupName,
          businessRegionCode: item.businessRegionCode,
          businessRegionSourceText: item.businessRegionSourceText,
          customerUnit: item.customerUnit,
        })), [
          { id: eventIds[0], sequence: 1, eventType: "legacy_adjustment", deltaAmount: "100.00", accountingMonth: "2026-08-01", occurredOn: "2026-08-01", reason: "分析回归", salespersonName: "分析业务员", departmentName: "分析甲部", groupName: "分析甲组", businessRegionCode: "CN-JS", businessRegionSourceText: "江苏来源", customerUnit: "客户单位甲" },
          { id: eventIds[3], sequence: 4, eventType: "legacy_adjustment", deltaAmount: "0.00", accountingMonth: "2026-08-01", occurredOn: "2026-08-01", reason: "分析回归", salespersonName: "分析业务员", departmentName: "分析甲部", groupName: "分析甲组", businessRegionCode: "CN-JS", businessRegionSourceText: "江苏来源", customerUnit: "客户单位甲" },
        ]);
        assert.ok(analysisReadCount <= 3, `订单事件穿透读取应不超过 3 次，实际 ${analysisReadCount} 次`);
        const smallEventsReadCount = analysisReadCount;
        const smallEventsQuery = requireCapturedQuery(analysisQuery);

        for (const [name, captured] of [
          ["省份客户", smallCustomersQuery],
          ["客户月份", smallMonthsQuery],
          ["订单事件", smallEventsQuery],
        ] as const) {
          const explain = await setup.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
            `explain (analyze,format json) ${captured.statement}`,
            captured.values,
          );
          assertNoPerRowAnalysisScan(explain.rows[0]!["QUERY PLAN"][0]!.Plan, `小基线${name}`);
        }

        const outOfScopeUrls = [
          "/api/performance/analysis/drilldown?level=customers&regionCode=CN-BJ&month=2026-08",
          "/api/performance/analysis/drilldown?level=months&regionCode=CN-BJ&customerUnit=%E8%8C%83%E5%9B%B4%E5%A4%96%E5%8D%95%E4%BD%8D&year=2026",
          "/api/performance/analysis/drilldown?level=events&regionCode=CN-BJ&customerUnit=%E8%8C%83%E5%9B%B4%E5%A4%96%E5%8D%95%E4%BD%8D&month=2026-08",
        ];
        for (const url of outOfScopeUrls) {
          const scoped = await app.inject({ method: "GET", url, headers: { cookie: leaderCookie } });
          assert.equal(scoped.statusCode, 200, scoped.body);
          assert.equal(scoped.json().eventCount, 0);
          assert.equal(scoped.json().totalAmount, "0.00");
        }

        const september = await app.inject({ method: "GET", url: "/api/performance/analysis?month=2026-09", headers: { cookie: leaderCookie } });
        assert.equal(september.statusCode, 200, september.body);
        assert.deepEqual(september.json().ledger, { eventCount: 1, totalAmount: "7.00" });
        assert.deepEqual(september.json().pending, { eventCount: 0, totalAmount: "0.00" });

        await setup.query("set session_replication_role=replica");
        await setup.query(
          `with new_orders as (
             insert into performance_orders
               (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
                salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
             select 'ANALYSIS-SCALE-'||lpad(series::text,4,'0'),'规模客户','客户单位甲','江苏来源','CN-JS',
                    $1,'分析业务员','2026-08-01',1,1,1,'active',now()
             from generate_series(1,2849) series returning id,qingflow_order_no
           ), numbered_orders as (
             select id,row_number() over(order by qingflow_order_no) as number from new_orders
           ), new_events as (
             insert into performance_events
               (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
                salesperson_person_id,salesperson_name,department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,order_sequence)
             select orders.id,case when series<=2849 then 'initial' else 'legacy_adjustment' end,1,
                    1+((series-1)/2849)::int,1+((series-1)/2849)::int,
                    '2026-08-01','2026-08-01','规模回归',$1,'分析业务员',$2,'分析甲部',$3,'分析甲组',$4,'分析组长',
                    1+((series-1)/2849)::int
             from generate_series(1,4696) series
             join numbered_orders orders on orders.number=((series-1)%2849)+1
             returning id
           )
           insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit)
           select id,'CN-JS','江苏来源',case when id in (select id from new_events order by id desc limit 1696) then '客户单位甲'
                                            else '规模单位'||lpad((((id-1)%60)+1)::text,2,'0') end
           from new_events`,
          [alicePersonId, departmentA.rows[0]!.id, groupA.rows[0]!.id, leaderPersonId],
        );
        await setup.query("set session_replication_role=origin");
        const scale = await setup.query<{ orders: string; events: string }>(
          `select count(distinct order_id)::text as orders,count(*)::text as events
           from performance_events where accounting_month='2026-08-01' and group_unit_id=$1`,
          [groupA.rows[0]!.id],
        );
        assert.deepEqual(scale.rows[0], { orders: "2850", events: "4701" });
        await setup.query("analyze performance_events");
        await setup.query("analyze performance_event_analysis_dimensions");
        analysisReadCount = 0;
        const scaled = await app.inject({ method: "GET", url: "/api/performance/analysis?month=2026-08", headers: { cookie: leaderCookie } });
        assert.equal(scaled.statusCode, 200, scaled.body);
        assert.ok(analysisReadCount <= 4, `规模数据分析读取应不超过 4 次，实际 ${analysisReadCount} 次`);
        assert.ok(Math.abs(analysisReadCount - smallReadCount) <= 1, `规模增长前后读取次数差应不超过 1，实际 ${smallReadCount} -> ${analysisReadCount}`);

        const insertConcurrentEvent = async (amount: number) => {
          const id = await insertEvent(order.rows[0]!.id, amount, "2026-08-01", alicePersonId, departmentA.rows[0]!.id, "分析甲部", groupA.rows[0]!.id, "分析甲组");
          await setup.query("set session_replication_role=replica");
          await setup.query("delete from performance_event_analysis_dimensions where event_id=$1", [id]);
          await setup.query(
            "insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit) values($1,'CN-JS','江苏来源','客户单位甲')",
            [id],
          );
          await setup.query("set session_replication_role=origin");
          return id;
        };
        const removeConcurrentEvent = async (id: string) => {
          await setup.query("set session_replication_role=replica");
          await setup.query("delete from performance_event_analysis_dimensions where event_id=$1", [id]);
          await setup.query("delete from performance_events where id=$1", [id]);
          await setup.query("set session_replication_role=origin");
        };
        const insertConcurrentDimension = async (customerUnit: string) => {
          await setup.query(
            "insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit) values($1,'CN-JS','并发补齐来源',$2)",
            [eventIds[4], customerUnit],
          );
        };
        const removeConcurrentDimension = async () => {
          await setup.query("set session_replication_role=replica");
          await setup.query("delete from performance_event_analysis_dimensions where event_id=$1", [eventIds[4]]);
          await setup.query("set session_replication_role=origin");
        };
        const waitForAnalysisShareLock = async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const waiting = await setup.query<{ waiting: boolean }>(
              `select exists(
                 select 1 from pg_locks locks
                 join pg_class relation on relation.oid=locks.relation
                 join pg_stat_activity activity on activity.pid=locks.pid
                 where relation.relname='performance_event_analysis_dimensions'
                   and locks.mode='ShareLock' and not locks.granted
                   and activity.application_name='sampleflow-api-runtime'
               ) as waiting`,
            );
            if (waiting.rows[0]!.waiting) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.fail("首屏分析必须等待在途维度写入提交后再冻结快照");
        };
        const scaledDrilldowns = [
          { name: "省份客户", url: "/api/performance/analysis/drilldown?level=customers&regionCode=CN-JS&month=2026-08", baseline: smallCustomersReadCount },
          { name: "客户月份", url: "/api/performance/analysis/drilldown?level=months&regionCode=CN-JS&customerUnit=%E5%AE%A2%E6%88%B7%E5%8D%95%E4%BD%8D%E7%94%B2&year=2026", baseline: smallMonthsReadCount },
          { name: "订单事件", url: "/api/performance/analysis/drilldown?level=events&regionCode=CN-JS&customerUnit=%E5%AE%A2%E6%88%B7%E5%8D%95%E4%BD%8D%E7%94%B2&month=2026-08", baseline: smallEventsReadCount },
        ];
        const largeDrilldownQueries: CapturedQuery[] = [];
        for (const drilldown of scaledDrilldowns) {
          analysisReadCount = 0;
          let heldEventId: string | null = null;
          let result: Awaited<ReturnType<typeof app.inject>>;
          if (drilldown.name === "省份客户") {
            const writer = new Client({ connectionString: database.url });
            await writer.connect();
            try {
              await writer.query("set session_replication_role=replica");
              await writer.query("begin");
              const heldEvent = await writer.query<{ id: string }>(
                `insert into performance_events
                  (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
                   salesperson_person_id,salesperson_name,department_unit_id,department_name,group_unit_id,group_name,leader_person_id,leader_name,order_sequence)
                 values($1,'legacy_adjustment',0,155,155,'2026-08-01','2026-08-01','乱序提交回归',$2,'分析业务员',$3,'分析甲部',$4,'分析甲组',$5,'分析组长',999)
                 returning id::text`,
                [order.rows[0]!.id, alicePersonId, departmentA.rows[0]!.id, groupA.rows[0]!.id, leaderPersonId],
              );
              heldEventId = heldEvent.rows[0]!.id;
              await writer.query(
                "insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit) values($1,'CN-JS','乱序提交来源','客户单位甲')",
                [heldEventId],
              );
              const pendingResult = app.inject({ method: "GET", url: drilldown.url, headers: { cookie: leaderCookie } });
              try {
                await waitForAnalysisShareLock();
              } finally {
                await writer.query("commit");
              }
              result = await pendingResult;
            } finally {
              await writer.end();
            }
          } else {
            result = await app.inject({ method: "GET", url: drilldown.url, headers: { cookie: leaderCookie } });
          }
          assert.equal(result.statusCode, 200, result.body.slice(0, 1_000));
          assert.ok(analysisReadCount <= 3, `规模数据${drilldown.name}穿透读取应不超过 3 次，实际 ${analysisReadCount} 次`);
          assert.ok(Math.abs(analysisReadCount - drilldown.baseline) <= 1, `${drilldown.name}规模增长前后读取次数差应不超过 1，实际 ${drilldown.baseline} -> ${analysisReadCount}`);
          largeDrilldownQueries.push(requireCapturedQuery(analysisQuery));
          if (drilldown.name === "省份客户") {
            const page = result.json();
            assert.equal(page.customers.length, 50);
            assert.equal(page.customerCount, 61);
            assert.equal(page.eventCount, 4699);
            assert.ok(page.nextCursor);
            const firstUnits = new Set(page.customers.map((customer: { customerUnit: string }) => customer.customerUnit));
            const concurrentEventId = await insertConcurrentEvent(-1_000_000_000);
            await insertConcurrentDimension("并发补齐单位");
            try {
              const next = await app.inject({ method: "GET", url: `${drilldown.url}&cursor=${encodeURIComponent(page.nextCursor)}`, headers: { cookie: leaderCookie } });
              assert.equal(next.statusCode, 200, next.body);
              assert.equal(next.json().customers.length, 11);
              assert.equal(next.json().customerCount, page.customerCount);
              assert.equal(next.json().customers.some((customer: { customerUnit: string }) => firstUnits.has(customer.customerUnit)), false);
              assert.equal(next.json().nextCursor, null);
            } finally {
              await removeConcurrentDimension();
              await removeConcurrentEvent(concurrentEventId);
              if (heldEventId) await removeConcurrentEvent(heldEventId);
            }
          }
          if (drilldown.name === "订单事件") {
            const page = result.json();
            assert.equal(page.orders.flatMap((order: { events: unknown[] }) => order.events).length, 100);
            assert.ok(page.nextCursor);
            const ids = new Set(page.orders.flatMap((order: { events: Array<{ id: string }> }) => order.events.map((event) => event.id)));
            const concurrentEventId = await insertConcurrentEvent(1);
            await insertConcurrentDimension("客户单位甲");
            try {
              const next = await app.inject({ method: "GET", url: `${drilldown.url}&cursor=${encodeURIComponent(page.nextCursor)}`, headers: { cookie: leaderCookie } });
              assert.equal(next.statusCode, 200, next.body.slice(0, 1_000));
              assert.equal(next.json().eventCount, page.eventCount);
              assert.equal(next.json().totalAmount, page.totalAmount);
              assert.equal(next.json().orders.flatMap((order: { events: Array<{ id: string }> }) => order.events).some((event: { id: string }) => ids.has(event.id) || event.id === concurrentEventId || event.id === eventIds[4]), false);
            } finally {
              await removeConcurrentDimension();
              await removeConcurrentEvent(concurrentEventId);
            }
          }
        }

        for (const [index, captured] of largeDrilldownQueries.entries()) {
          const explain = await setup.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
            `explain (analyze,format json) ${captured.statement}`,
            captured.values,
          );
          assertNoPerRowAnalysisScan(explain.rows[0]!["QUERY PLAN"][0]!.Plan, `2,850 订单／4,701 事件基线${scaledDrilldowns[index]!.name}`);
        }

        const largeExplain = await setup.query<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>(
          `explain (analyze,format json) ${capturedAnalysisQuery.statement}`,
          capturedAnalysisQuery.values,
        );
        assertNoPerRowAnalysisScan(largeExplain.rows[0]!["QUERY PLAN"][0]!.Plan, "2,850 订单／4,701 事件基线");

        const adminCookie = await loginCookie(app, "analysis_admin");
        const forbidden = await app.inject({ method: "GET", url: "/api/performance/analysis?month=2026-08", headers: { cookie: adminCookie } });
        assert.equal(forbidden.statusCode, 403, forbidden.body);
        analysisShareLockCount = 0;
        for (const url of scaledDrilldowns.map((item) => item.url)) {
          const drilldownForbidden = await app.inject({ method: "GET", url, headers: { cookie: adminCookie } });
          assert.equal(drilldownForbidden.statusCode, 403, drilldownForbidden.body);
        }
        assert.equal(analysisShareLockCount, 0, "无业务查看权限的账号不得取得分析维度写阻塞锁");
        const unauthenticated = await app.inject({ method: "GET", url: scaledDrilldowns[0]!.url });
        assert.equal(unauthenticated.statusCode, 401, unauthenticated.body);
        const invalid = await app.inject({ method: "GET", url: "/api/performance/analysis?month=2026-13", headers: { cookie: leaderCookie } });
        assert.equal(invalid.statusCode, 400, invalid.body);
        for (const url of [
          "/api/performance/analysis/drilldown?level=unknown&regionCode=CN-JS&month=2026-08",
          "/api/performance/analysis/drilldown?level=customers&regionCode=CN-UNKNOWN&month=2026-08",
          "/api/performance/analysis/drilldown?level=customers&regionCode=CN-JS&month=2026-08&extra=true",
          "/api/performance/analysis/drilldown?level=customers&regionCode=CN-JS&month=2026-08&cursor=invalid%25",
          "/api/performance/analysis/drilldown?level=months&regionCode=CN-JS&customerUnit=%20%20&year=2026",
        ]) {
          const drilldownInvalid = await app.inject({ method: "GET", url, headers: { cookie: leaderCookie } });
          assert.equal(drilldownInvalid.statusCode, 400, drilldownInvalid.body);
        }
      } finally {
        await app.close();
        await pool.end();
      }
    } finally {
      await setup.end();
    }
  });
});
