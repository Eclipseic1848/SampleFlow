import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const ORIGIN = "http://127.0.0.1:4174";
const standardTemplate = fileURLToPath(new URL("../../web/public/SampleFlow标准业绩导入模板.xlsx", import.meta.url));

test("系统续导无需配置审批，保留角色边界、来源校验、并发幂等和用户草稿", async () => {
  await withMigratedTestDatabase(async database => {
    for (const role of ["sales_assistant_leader","sales_assistant","hr","salesperson"]) {
      await seedTestUser(database.url,{username:role,displayName:role,password:"Role@123",roleCode:role,roleName:role});
    }
    const client = new pg.Client({connectionString:database.url});await client.connect();
    try {
      await client.query(`insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,required_columns)
        select 'excel-ledger-continuation',1,'旧草稿','draft',sheet_name,expected_headers,column_mapping,required_columns
        from import_configs where config_key='standard-performance' and version=2`);
      const before = (await client.query("select row_to_json(c) as data from import_configs c order by id")).rows;
      await withTestApi(database.url,async app => {
        const leader=await loginHeaders(app,"sales_assistant_leader");const assistant=await loginHeaders(app,"sales_assistant");
        const payload={purpose:"continuation",fileName:"续导.xlsx",contentBase64:(await readFile(standardTemplate)).toString("base64")};
        const send=(headers:Record<string,string>,body:Record<string,unknown>=payload)=>app.inject({method:"POST",url:"/api/imports/preflight",headers,payload:body});
        for (const role of ["hr","salesperson"]) assert.equal((await send(await loginHeaders(app,role))).statusCode,403);
        assert.equal((await send({})).statusCode,401);
        assert.equal((await send(leader,{...payload,configId:"1"})).statusCode,400);
        assert.equal((await send(leader,{...payload,allowedEventTypes:["initial"]})).statusCode,400);
        assert.equal((await send(leader,{...payload,contentBase64:"invalid"})).statusCode,409);
        assert.deepEqual((await client.query("select row_to_json(c) as data from import_configs c order by id")).rows,before);
        const results=await Promise.all([send(leader),send(assistant)]);
        for(const result of results) {
          assert.equal(result.statusCode,200,result.body);
          assert.ok(result.json().issues.some((issue:{code:string})=>issue.code==="CONTINUATION_TOTAL_CONFIRMATION"));
        }
        const system=(await client.query("select * from import_configs where config_key='excel-ledger-continuation' and status='approved'")).rows;
        assert.equal(system.length,1);assert.equal(system[0].created_by,null);assert.equal(system[0].approved_by,null);
        assert.equal(system[0].fixed_event_type,"legacy_adjustment");assert.equal(system[0].column_mapping.sourceRecordId,undefined);
        assert.equal(system[0].expected_reconciliation,null);
        assert.deepEqual((await client.query("select row_to_json(c) as data from import_configs c where id<>$1 order by id",[system[0].id])).rows,before);
        assert.equal((await client.query("select count(*) from audit_logs where action='import.continuation_rule_initialized'")).rows[0].count,"1");
        assert.equal((await client.query("select count(*) from performance_events")).rows[0].count,"0");
        const denied=await app.inject({method:"POST",url:`/api/imports/batches/${results[1]!.json().batchId}/confirm`,headers:assistant,payload:{confirmedWarnings:[]}});
        assert.equal(denied.statusCode,403);
        assert.equal((await send(leader)).statusCode,200);
        assert.equal((await client.query("select count(*) from import_configs where config_key='excel-ledger-continuation' and status='approved'")).rows[0].count,"1");
        await client.query("update import_configs set status='retired' where config_key='standard-performance'");
        const unavailable=await send(leader);assert.equal(unavailable.statusCode,409);assert.match(unavailable.body,/系统标准模板不可用/);
      });
    } finally { await client.end(); }
  });
});

async function loginHeaders(app: Parameters<Parameters<typeof withTestApi>[1]>[0], username: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: ORIGIN },
    payload: { username, password: "Role@123" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const setCookies = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"].map(String)
    : [String(response.headers["set-cookie"])];
  const cookies = setCookies.map((value) => value.split(";", 1)[0] ?? "");
  const csrf = cookies.find((value) => value.startsWith("sampleflow_csrf="));
  assert.ok(csrf);
  return { cookie: cookies.join("; "), origin: ORIGIN, "x-csrf-token": decodeURIComponent(csrf.slice("sampleflow_csrf=".length)) };
}

const config = {
  configKey: "offline-layout",
  name: "线下格式",
  sheetName: "线下明细",
  expectedHeaders: ["含税金额","业务备注","记录类型","流水号","人员编码","地区","单位","客户","业务日期","订单号","项目"],
  columnMapping: {
    sourceRecordId: "流水号", orderNo: "订单号", occurredOn: "业务日期", customerName: "客户",
    customerUnit: "单位", businessRegionSourceText: "地区", salespersonSourceKey: "人员编码",
    serviceType: "项目", eventType: "记录类型", amount: "含税金额", reason: "业务备注",
  },
  requiredColumns: ["sourceRecordId","orderNo","occurredOn","customerName","customerUnit","businessRegionSourceText","salespersonSourceKey","eventType","amount","reason"],
  allowedEventTypes: ["initial"],
  businessRegionMapping: { 江苏: "CN-JS", 外贸: "EXT-TRADE" },
  personMapping: {},
  allowLegacySourceKey: false,
};

test("导入配置草稿与批准遵守销售助理组长/人事职责分离", async () => {
  await withMigratedTestDatabase(async (database) => {
    await seedTestUser(database.url, { username: "import_leader", displayName: "导入组长", password: "Role@123", roleCode: "sales_assistant_leader", roleName: "销售助理组长" });
    await seedTestUser(database.url, { username: "import_assistant", displayName: "导入助理", password: "Role@123", roleCode: "sales_assistant", roleName: "销售助理" });
    await seedTestUser(database.url, { username: "import_hr", displayName: "导入人事", password: "Role@123", roleCode: "hr", roleName: "人事部" });
    await seedTestUser(database.url, { username: "import_sales", displayName: "普通业务员", password: "Role@123", roleCode: "salesperson", roleName: "业务员" });
    await withTestApi(database.url, async (app) => {
      const leader = await loginHeaders(app, "import_leader");
      const assistant = await loginHeaders(app, "import_assistant");
      const hr = await loginHeaders(app, "import_hr");
      const salesperson = await loginHeaders(app, "import_sales");

      const historicalWarnings = Array.from({ length: 199 }, (_, index) => `${index + 2}:HISTORICAL_REVIEW_REQUIRED`);
      const warningCapacity = await app.inject({
        method: "POST", url: "/api/imports/batches/999999/confirm", headers: leader,
        payload: { confirmedWarnings: historicalWarnings },
      });
      assert.equal(warningCapacity.statusCode, 409, warningCapacity.body);

      const deniedCreate = await app.inject({ method: "POST", url: "/api/imports/configs", headers: assistant, payload: config });
      assert.equal(deniedCreate.statusCode, 403);
      const duplicateHeaders = await app.inject({
        method: "POST", url: "/api/imports/configs", headers: leader,
        payload: { ...config, expectedHeaders: [...config.expectedHeaders, "订单号"] },
      });
      assert.equal(duplicateHeaders.statusCode, 400);
      const conflictingEventSources = await app.inject({
        method: "POST", url: "/api/imports/configs", headers: leader,
        payload: { ...config, allowLegacySourceKey: true, fixedEventType: "legacy_adjustment" },
      });
      assert.equal(conflictingEventSources.statusCode, 400);
      const legacySourceWithoutFixedEvent = await app.inject({
        method: "POST", url: "/api/imports/configs", headers: leader,
        payload: { ...config, allowLegacySourceKey: true },
      });
      assert.equal(legacySourceWithoutFixedEvent.statusCode, 400);
      const { sourceRecordId: _sourceRecordId, eventType: _eventType, ...historicalColumnMapping } = config.columnMapping;
      const historicalConfig = {
        ...config,
        configKey: "historical-layout",
        name: "历史线下格式",
        columnMapping: historicalColumnMapping,
        requiredColumns: config.requiredColumns.filter((column) => column !== "sourceRecordId" && column !== "eventType"),
        allowedEventTypes: ["legacy_adjustment"],
        fixedEventType: "legacy_adjustment",
        allowLegacySourceKey: true,
        expectedReconciliation: {
          rows: 2,
          orders: 2,
          events: 2,
          totalAmount: 150,
          monthly: [
            { month: "2026-03", events: 1, totalAmount: 100 },
            { month: "2026-04", events: 1, totalAmount: 50 },
          ],
        },
      };
      const { expectedReconciliation: _expectedReconciliation, ...historicalWithoutBaseline } = historicalConfig;
      const missingHistoricalBaseline = await app.inject({ method: "POST", url: "/api/imports/configs", headers: leader, payload: historicalWithoutBaseline });
      assert.equal(missingHistoricalBaseline.statusCode, 400);
      assert.match(missingHistoricalBaseline.json<{ message: string }>().message, /历史配置必须固化/);
      const continuation = { ...historicalWithoutBaseline, configKey: "excel-ledger-continuation", name: "接着导入 Excel 业绩流水" };
      const continuationCreated = await app.inject({ method: "POST", url: "/api/imports/configs", headers: leader, payload: continuation });
      assert.equal(continuationCreated.statusCode, 201, continuationCreated.body);
      const continuationId = continuationCreated.json<{id:string}>().id;
      const duplicateContinuation = await app.inject({method:"POST",url:"/api/imports/configs",headers:leader,payload:continuation});
      assert.equal(duplicateContinuation.statusCode,409,duplicateContinuation.body);
      const continuationDenied = await app.inject({ method: "POST", url: `/api/imports/configs/${continuationId}/approve`, headers: leader, payload: {} });
      assert.equal(continuationDenied.statusCode, 403);
      const continuationApproved = await app.inject({ method: "POST", url: `/api/imports/configs/${continuationId}/approve`, headers: hr, payload: {} });
      assert.equal(continuationApproved.statusCode, 200, continuationApproved.body);
      for (const invalid of [
        { ...continuation, expectedReconciliation: historicalConfig.expectedReconciliation },
        { ...continuation, columnMapping: { ...continuation.columnMapping, sourceRecordId: "订单号" } },
        { ...config, configKey: "excel-ledger-continuation" },
      ]) {
        const rejected = await app.inject({ method: "POST", url: "/api/imports/configs", headers: leader, payload: invalid });
        assert.equal(rejected.statusCode, 400, rejected.body);
      }
      const inconsistentHistoricalBaseline = await app.inject({
        method: "POST", url: "/api/imports/configs", headers: leader,
        payload: { ...historicalConfig, configKey: "historical-invalid", expectedReconciliation: { ...historicalConfig.expectedReconciliation, totalAmount: 151 } },
      });
      assert.equal(inconsistentHistoricalBaseline.statusCode, 400);
      assert.match(inconsistentHistoricalBaseline.json<{ message: string }>().message, /逐月金额合计/);
      const historicalCreated = await app.inject({ method: "POST", url: "/api/imports/configs", headers: leader, payload: historicalConfig });
      assert.equal(historicalCreated.statusCode, 201, historicalCreated.body);
      const historicalId = historicalCreated.json<{ id: string }>().id;
      const historicalApproved = await app.inject({ method: "POST", url: `/api/imports/configs/${historicalId}/approve`, headers: hr, payload: {} });
      assert.equal(historicalApproved.statusCode, 200, historicalApproved.body);
      const created = await app.inject({ method: "POST", url: "/api/imports/configs", headers: leader, payload: config });
      assert.equal(created.statusCode, 201, created.body);
      const id = created.json<{ id: string }>().id;
      const updated = await app.inject({ method: "PATCH", url: `/api/imports/configs/${id}`, headers: leader, payload: { ...config, name: "线下格式修订" } });
      assert.equal(updated.statusCode, 200, updated.body);
      const deniedApprove = await app.inject({ method: "POST", url: `/api/imports/configs/${id}/approve`, headers: leader, payload: {} });
      assert.equal(deniedApprove.statusCode, 403);
      const approved = await app.inject({ method: "POST", url: `/api/imports/configs/${id}/approve`, headers: hr, payload: {} });
      assert.equal(approved.statusCode, 200, approved.body);

      const templateConfig = {
        configKey: "standard-template",
        name: "标准模板",
        sheetName: "分子",
        expectedHeaders: ["收样月份", "日期", "订单编号（来源于轻流系统）", "客户姓名", "客户单位", "省份", "业务员", "部门", "组别", "系统营业额", "服务类型", "备注", null, "协作人", "协作比例"],
        columnMapping: {
          sourceMonth: "收样月份", occurredOn: "日期", sourceRecordId: "订单编号（来源于轻流系统）",
          orderNo: "订单编号（来源于轻流系统）", customerName: "客户姓名", customerUnit: "客户单位",
          businessRegionSourceText: "省份", salespersonSourceKey: "业务员", sourceDepartment: "部门",
          sourceGroup: "组别", amount: "系统营业额", serviceType: "服务类型", reason: "备注",
          collaboratorSourceKey: "协作人", collaborationRatio: "协作比例",
        },
        requiredColumns: ["sourceMonth", "occurredOn", "orderNo", "customerName", "customerUnit", "businessRegionSourceText", "salespersonSourceKey", "sourceDepartment", "sourceGroup", "amount", "serviceType"],
        allowedEventTypes: ["initial"],
        businessRegionMapping: { 外贸: "EXT-TRADE" },
        personMapping: {},
        fixedEventType: "initial",
        allowLegacySourceKey: false,
      };
      const templateCreated = await app.inject({ method: "POST", url: "/api/imports/configs", headers: leader, payload: templateConfig });
      assert.equal(templateCreated.statusCode, 201, templateCreated.body);
      const templateId = templateCreated.json<{ id: string }>().id;
      const templateApproved = await app.inject({ method: "POST", url: `/api/imports/configs/${templateId}/approve`, headers: hr, payload: {} });
      assert.equal(templateApproved.statusCode, 200, templateApproved.body);
      const preflight = await app.inject({
        method: "POST",
        url: "/api/imports/preflight",
        headers: leader,
        payload: {
          configId: templateId,
          fileName: "SampleFlow标准业绩导入模板.xlsx",
          contentBase64: (await readFile(standardTemplate)).toString("base64"),
        },
      });
      assert.equal(preflight.statusCode, 200, preflight.body);
      assert.equal(preflight.json<{ status: string }>().status, "blocked");
      const metrics = await app.inject({ method: "GET", url: "/internal/metrics" });
      assert.match(metrics.body, /sampleflow_operation_failures_total\{operation="import",result="failure",reason_code="IMPORT_PREFLIGHT_BLOCKED"\} 1/);

      const deniedList = await app.inject({ method: "GET", url: "/api/imports/configs", headers: salesperson });
      assert.equal(deniedList.statusCode, 403);
      const visible = await app.inject({ method: "GET", url: "/api/imports/configs", headers: assistant });
      assert.equal(visible.statusCode, 200, visible.body);
      const visibleConfigs = visible.json<{ configs: { id: string; status: string; name:string; requiredColumns:string[]; expectedReconciliation?: unknown; fixedEventType?:string|null }[] }>().configs;
      assert.ok(visibleConfigs.some((item) => item.id === id && item.status === "approved" && item.name === "线下格式修订" && item.requiredColumns.includes("orderNo")));
      assert.deepEqual(visibleConfigs.find((item) => item.id === historicalId)?.expectedReconciliation, historicalConfig.expectedReconciliation);
      assert.equal(visibleConfigs.find((item) => item.id === historicalId)?.fixedEventType, "legacy_adjustment");
    });
  });
});
