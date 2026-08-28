import assert from "node:assert/strict";
import test from "node:test";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const ORIGIN = "http://127.0.0.1:4174";

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
      const created = await app.inject({ method: "POST", url: "/api/imports/configs", headers: leader, payload: config });
      assert.equal(created.statusCode, 201, created.body);
      const id = created.json<{ id: string }>().id;
      const updated = await app.inject({ method: "PATCH", url: `/api/imports/configs/${id}`, headers: leader, payload: { ...config, name: "线下格式修订" } });
      assert.equal(updated.statusCode, 200, updated.body);
      const deniedApprove = await app.inject({ method: "POST", url: `/api/imports/configs/${id}/approve`, headers: leader, payload: {} });
      assert.equal(deniedApprove.statusCode, 403);
      const approved = await app.inject({ method: "POST", url: `/api/imports/configs/${id}/approve`, headers: hr, payload: {} });
      assert.equal(approved.statusCode, 200, approved.body);
      const deniedList = await app.inject({ method: "GET", url: "/api/imports/configs", headers: salesperson });
      assert.equal(deniedList.statusCode, 403);
      const visible = await app.inject({ method: "GET", url: "/api/imports/configs", headers: assistant });
      assert.equal(visible.statusCode, 200, visible.body);
      assert.ok(visible.json<{ configs: { id: string; status: string; name:string; requiredColumns:string[] }[] }>().configs.some((item) => item.id === id && item.status === "approved" && item.name === "线下格式修订" && item.requiredColumns.includes("orderNo")));
    });
  });
});
