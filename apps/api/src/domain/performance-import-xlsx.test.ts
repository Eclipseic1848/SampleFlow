import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mapImportWorksheetRows, parseImportWorkbook, type ImportLayout } from "./performance-import-xlsx.js";

const standard: ImportLayout = {
  sheetName: "业绩导入",
  columnMapping: {
    sourceRecordId: "来源记录标识", orderNo: "轻流订单编号", occurredOn: "发生日期",
    customerName: "客户姓名", customerUnit: "客户单位", businessRegionSourceText: "业务区域",
    salespersonSourceKey: "业务员来源标识", serviceType: "服务类型", eventType: "事件类型",
    amount: "金额", reason: "原因",
  },
};

const sheet3: ImportLayout = {
  sheetName: "分子",
  expectedHeaders: ["收样月份", "日期", "订单编号（来源于轻流系统）", "客户姓名", "客户单位", "省份", "业务员", "部门", "组别", "系统营业额", "服务类型", "备注", null, "协作人", "协作比例"],
  columnMapping: {
    sourceMonth: "收样月份", occurredOn: "日期", sourceRecordId: "订单编号（来源于轻流系统）",
    orderNo: "订单编号（来源于轻流系统）", customerName: "客户姓名", customerUnit: "客户单位",
    businessRegionSourceText: "省份", salespersonSourceKey: "业务员", sourceDepartment: "部门",
    sourceGroup: "组别", amount: "系统营业额", serviceType: "服务类型", reason: "备注",
    collaboratorSourceKey: "协作人", collaborationRatio: "协作比例",
  },
  fixedEventType: "initial",
};

test("同一领域字段可由两个获批列布局精确映射，不猜测列名", () => {
  const date = new Date("2026-03-05T00:00:00Z");
  const standardRows = mapImportWorksheetRows([
    Object.values(standard.columnMapping),
    ["SRC-1", "001-A", date, "客户甲", "单位甲", "江苏省", "person:a", "检测", "initial", 100, "首次转录"],
  ], standard);
  const alternate: ImportLayout = {
    sheetName: "线下明细",
    columnMapping: {
      amount: "含税金额", reason: "业务备注", eventType: "记录类型", sourceRecordId: "流水号",
      salespersonSourceKey: "人员编码", businessRegionSourceText: "地区", customerUnit: "单位",
      customerName: "客户", occurredOn: "业务日期", orderNo: "订单号", serviceType: "项目",
    },
  };
  const alternateRows = mapImportWorksheetRows([
    Object.values(alternate.columnMapping),
    [100, "首次转录", "initial", "SRC-1", "person:a", "江苏省", "单位甲", "客户甲", date, "001-A", "检测"],
  ], alternate);
  assert.deepEqual(
    { ...standardRows[0], sheet: undefined },
    { ...alternateRows[0], sheet: undefined },
  );
});

test("未知或缺失表头被阻断", () => {
  assert.throws(() => mapImportWorksheetRows([["订单号"]], standard), /表头与所选配置不一致/);
});

test("获批列布局可以精确读取同日业务顺序", () => {
  const layout: ImportLayout = {
    sheetName: "调整流水",
    columnMapping: { ...standard.columnMapping, businessSequence: "业务顺序" },
  };
  const rows = mapImportWorksheetRows([
    Object.values(layout.columnMapping),
    ["SRC-1", "001-A", new Date("2026-03-05T00:00:00Z"), "客户甲", "单位甲", "江苏省", "person:a", "检测", "pause", 0, "暂停", 2],
  ], layout);
  assert.equal(rows[0]?.businessSequence, 2);
});

test("更正授权标识保留 bigint 文本且只兼容安全整数单元格", () => {
  const layout: ImportLayout = {
    sheetName: "更正流水",
    columnMapping: { ...standard.columnMapping, correctionRequestId: "更正授权标识" },
  };
  const base = ["SRC-1", "001-A", new Date("2026-03-05T00:00:00Z"), "客户甲", "单位甲", "江苏省", "person:a", "检测", "revenue_change", 90, "更正"];
  const rows = mapImportWorksheetRows([
    Object.values(layout.columnMapping),
    [...base, "9007199254740993"],
    [...base, 42],
    [...base, Number.MAX_SAFE_INTEGER + 1],
    [...base, null],
  ], layout);
  assert.deepEqual(rows.map((row) => row.correctionRequestId), ["9007199254740993", "42", "", undefined]);
});

test("空备注按空文本原样保留，不自动补写业务语义", () => {
  const date = new Date("2026-03-05T00:00:00Z");
  const rows = mapImportWorksheetRows([
    Object.values(standard.columnMapping),
    ["SRC-1", "001-A", date, "客户甲", "单位甲", "江苏省", "person:a", "检测", "initial", 100, null],
  ], standard);
  assert.equal(rows[0]?.reason, "");
});

test("工作表逐行保留无效值与原始行号，交由预检一次汇总", () => {
  const validDate = new Date("2026-03-05T00:00:00Z");
  const rows = mapImportWorksheetRows([
    Object.values(standard.columnMapping),
    ["SRC-1", "001-A", "错误日期", null, "单位甲", "江苏省", "person:a", "检测", "unsupported", "错误金额", null],
    Array(11).fill(null),
    ["SRC-2", "002-A", validDate, "客户乙", "单位乙", "江苏省", "person:b", "检测", "initial", 50, ""],
  ], standard);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.rowNumber, 2);
  assert.equal(rows[0]?.occurredOn, "错误日期");
  assert.equal(rows[0]?.customerName, "");
  assert.ok(Number.isNaN(rows[0]?.amount));
  assert.equal(rows[0]?.eventType, "unsupported");
  assert.equal(rows[1]?.rowNumber, 4);
});

test("获批历史布局可保留忽略列、固定历史事件类型并精确映射人员", () => {
  const date = new Date("2026-03-05T00:00:00Z");
  const legacy: ImportLayout = {
    sheetName: "分子",
    expectedHeaders: ["日期", "订单编号", "业务员", "系统营业额", "备注", "客户", "客户单位", "省份", "服务类型", "仅作证据"],
    columnMapping: {
      orderNo: "订单编号", occurredOn: "日期", customerName: "客户", customerUnit: "客户单位",
      businessRegionSourceText: "省份", salespersonSourceKey: "业务员", serviceType: "服务类型",
      amount: "系统营业额", reason: "备注",
    },
    personMapping: { "业务员甲": "person:a" },
    fixedEventType: "legacy_adjustment",
  };
  const rows = mapImportWorksheetRows([
    legacy.expectedHeaders!,
    [date, "001-A", "业务员甲", -25.5, "原始备注", "客户甲", "单位甲", "江苏省", "检测", "保留但不映射"],
  ], legacy);
  assert.equal(rows[0]?.sourceRecordId, undefined);
  assert.equal(rows[0]?.eventType, "legacy_adjustment");
  assert.equal(rows[0]?.salespersonSourceKey, "person:a");
  assert.equal(rows[0]?.amount, -25.5);
});

test("Sheet3 新订单布局保留负数、组织来源与协作比例", () => {
  const rows = mapImportWorksheetRows([
    sheet3.expectedHeaders!,
    ["3月", new Date("2026-03-05T00:00:00Z"), "SF-001", "客户甲", "单位甲", "台湾省", "业务员甲", "销售部", "一组", -100, "检测", "应收未收", null, "业务员乙", 0.2],
  ], sheet3);
  assert.deepEqual(rows[0], {
    sheet: "分子", rowNumber: 2, sourceRecordId: "SF-001", sourceMonth: "3月", orderNo: "SF-001",
    occurredOn: "2026-03-05", customerName: "客户甲", customerUnit: "单位甲", businessRegionSourceText: "台湾省",
    salespersonSourceKey: "业务员甲", sourceDepartment: "销售部", sourceGroup: "一组", serviceType: "检测",
    collaboratorSourceKey: "业务员乙", collaborationRatio: 0.2, eventType: "initial", amount: -100, reason: "应收未收",
  });
});

test("可下载的标准模板与标准配置兼容且不含公式", async () => {
  const template = fileURLToPath(new URL("../../../web/public/SampleFlow标准业绩导入模板.xlsx", import.meta.url));
  const bytes = await readFile(template);
  const rows = await parseImportWorkbook("SampleFlow标准业绩导入模板.xlsx", bytes, sheet3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.orderNo, "001-A");
  assert.equal(rows[0]?.businessRegionSourceText, "外贸");
  assert.equal(rows[0]?.sourceDepartment, "E2E 销售部");
  assert.equal(rows[0]?.sourceGroup, "E2E 销售组");
});
