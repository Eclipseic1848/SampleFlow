import assert from "node:assert/strict";
import test from "node:test";
import { ledgerUnitEvidenceKey, preflightOrganizationImport, type LeadershipMapping } from "./organization-import.js";
import { assertFixedValueXlsxArchive } from "./xlsx-safety.js";

const organizationRows = [
  { personName:"甲", departmentName:"一部", groupName:"一组" },
  { personName:"乙", departmentName:"二部", groupName:"二组" },
  { personName:"仅身份", departmentName:"一部", groupName:"待确认岗位" },
];
const ledgerPeople = new Set(["甲", "乙"]);
const ledgerUnits = new Set([
  ledgerUnitEvidenceKey("甲", "一部", "一组"),
  ledgerUnitEvidenceKey("乙", "二部", "二组"),
]);

test("组织预检在缺少权威负责人映射时只报告差异并阻断", () => {
  const report = preflightOrganizationImport(organizationRows, ledgerPeople, ledgerUnits);
  assert.equal(report.ready, false);
  assert.deepEqual(report.counts, { identities:3, historicalPeople:2, historicalGroups:2, departments:2, peopleWithoutHistoricalPerformance:1 });
  assert.deepEqual(report.peopleWithoutHistoricalPerformance, ["仅身份"]);
  assert.match(report.blockers.join("\n"), /缺少人事确认/);
});

test("组织预检要求每个历史小组和部门恰好一个有效负责人", () => {
  const mapping: LeadershipMapping = {
    source:"人事确认单", confirmedBy:"人事负责人", confirmedAt:"2026-08-27",
    groupLeaders:[
      { departmentName:"一部", groupName:"一组", personName:"甲", effectiveFrom:"2026-01-01" },
      { departmentName:"二部", groupName:"二组", personName:"乙", effectiveFrom:"2026-01-01" },
    ],
    departmentSupervisors:[
      { departmentName:"一部", personName:"甲", effectiveFrom:"2026-01-01" },
      { departmentName:"二部", personName:"乙", effectiveFrom:"2026-01-01" },
    ],
  };
  const report = preflightOrganizationImport(organizationRows, ledgerPeople, ledgerUnits, mapping);
  assert.equal(report.ready, true, report.blockers.join("\n"));
});

test("普通预检阻断负责人日期未覆盖历史事件",()=>{
  const mapping:LeadershipMapping={
    source:"人事确认单",confirmedBy:"人事负责人",confirmedAt:"2026-08-27",
    groupLeaders:[
      {departmentName:"一部",groupName:"一组",personName:"甲",effectiveFrom:"2026-02-01"},
      {departmentName:"二部",groupName:"二组",personName:"乙",effectiveFrom:"2026-01-01"},
    ],
    departmentSupervisors:[
      {departmentName:"一部",personName:"甲",effectiveFrom:"2026-01-01"},
      {departmentName:"二部",personName:"乙",effectiveFrom:"2026-01-01"},
    ],
  };
  const report=preflightOrganizationImport(organizationRows,ledgerPeople,ledgerUnits,mapping,[
    {personName:"甲",departmentName:"一部",groupName:"一组",occurredOn:"2026-01-15"},
  ]);
  assert.equal(report.ready,false);
  assert.match(report.blockers.join("\n"),/小组负责人未覆盖历史日期/);
});

test("专用历史组织迁移阻断固定数量基线漂移",()=>{
  const mapping:LeadershipMapping={
    source:"人事确认单",confirmedBy:"人事负责人",confirmedAt:"2026-08-27",
    groupLeaders:[
      {departmentName:"一部",groupName:"一组",personName:"甲",effectiveFrom:"2026-01-01"},
      {departmentName:"二部",groupName:"二组",personName:"乙",effectiveFrom:"2026-01-01"},
    ],
    departmentSupervisors:[
      {departmentName:"一部",personName:"甲",effectiveFrom:"2026-01-01"},
      {departmentName:"二部",personName:"乙",effectiveFrom:"2026-01-01"},
    ],
  };
  const report=preflightOrganizationImport(organizationRows,ledgerPeople,ledgerUnits,mapping,[],{
    identities:63,historicalPeople:59,historicalGroups:16,departments:5,
  });
  assert.equal(report.ready,false);
  assert.match(report.blockers.join("\n"),/迁移基线不一致：人员身份应为 63，实际 3/);
  assert.match(report.blockers.join("\n"),/历史人员应为 59，实际 2/);
});

test("工作簿安全门禁拒绝公式、外部链接和外部数据连接",()=>{
  const bytes=(value:string)=>new TextEncoder().encode(value);
  for(const archive of [
    {"xl/worksheets/sheet1.xml":bytes("<worksheet><f>A1+1</f></worksheet>")},
    {"xl/externalLinks/externalLink1.xml":bytes("<externalLink/>")},
    {"xl/connections.xml":bytes("<connections/>")},
    {"xl/queryTables/queryTable1.xml":bytes("<queryTable/>")},
    {"xl/worksheets/_rels/sheet1.xml.rels":bytes('<Relationship TargetMode="External"/>')},
  ])assert.throws(()=>assertFixedValueXlsxArchive(archive),/拒绝包含/);
});
