import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readXlsxFile from "read-excel-file/node";
import { unzipSync } from "fflate";
import {
  HISTORICAL_ORGANIZATION_BASELINE,
  ledgerUnitEvidenceKey,
  preflightOrganizationImport,
  type LeadershipMapping,
  type OrganizationSourceRow,
} from "../domain/organization-import.js";
import { db } from "../db.js";
import { assertFixedValueXlsxArchive } from "../domain/xlsx-safety.js";
import { applyOrganizationImport, type LedgerOrganizationRow } from "../services/organization-import.js";

function argument(name:string):string|undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredText(value:unknown, label:string, rowNumber:number):string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`“组别”工作表第 ${rowNumber} 行${label}必须是无首尾空格的非空文本`);
  }
  return value;
}

const sourceArgument = argument("--source");
if (!sourceArgument) throw new Error("必须通过 --source 显式指定待预检的 .xlsx 文件");
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const sourceFile = path.resolve(invocationDirectory,sourceArgument);
if (path.extname(sourceFile).toLowerCase() !== ".xlsx") throw new Error("组织预检只接受 .xlsx 文件");

const sourceBytes = await readFile(sourceFile);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const archive=unzipSync(sourceBytes);
assertFixedValueXlsxArchive(archive);
const sheets = await readXlsxFile(sourceFile);
const organizationSheet = sheets.find((sheet) => sheet.sheet === "组别");
const ledgerSheet = sheets.find((sheet) => sheet.sheet === "分子");
if (!organizationSheet || !ledgerSheet) throw new Error("工作簿必须同时包含“组别”和“分子”工作表");
const expectedOrganizationHeader=["业务员","组别","部门"];
const expectedLedgerHeader=["收样月份","日期","订单编号（来源于轻流系统）","客户姓名","客户单位","省份","业务员","部门","组别","系统营业额","服务类型","备注",null,"协作人","协作比例"];
if(JSON.stringify(organizationSheet.data[0])!==JSON.stringify(expectedOrganizationHeader))throw new Error("“组别”工作表表头与获批历史格式不一致");
if(JSON.stringify(ledgerSheet.data[0])!==JSON.stringify(expectedLedgerHeader))throw new Error("“分子”工作表表头与获批历史格式不一致");

const organizationRows:OrganizationSourceRow[] = organizationSheet.data.slice(1).map((row, index) => ({
  personName: requiredText(row[0], "业务员", index + 2),
  groupName: requiredText(row[1], "组别", index + 2),
  departmentName: requiredText(row[2], "部门", index + 2),
}));
const ledgerPeople = new Set<string>();
const ledgerUnits = new Set<string>();
const ledgerRows:LedgerOrganizationRow[] = [];
for (const [index, row] of ledgerSheet.data.slice(1).entries()) {
  if (!(row[1] instanceof Date)) throw new Error(`“分子”工作表第 ${index + 2} 行日期无效`);
  const personName = requiredText(row[6], "业务员", index + 2);
  const departmentName = requiredText(row[7], "部门", index + 2);
  const groupName = requiredText(row[8], "组别", index + 2);
  if(typeof row[9]!=="number"||!Number.isFinite(row[9]))throw new Error(`“分子”工作表第 ${index + 2} 行金额无效`);
  ledgerPeople.add(personName);
  ledgerUnits.add(ledgerUnitEvidenceKey(personName, departmentName, groupName));
  ledgerRows.push({ personName,departmentName,groupName,occurredOn:row[1].toISOString().slice(0,10),amount:row[9] });
}

const mappingFile = argument("--mapping");
const mappingBytes = mappingFile ? await readFile(path.resolve(invocationDirectory,mappingFile)) : undefined;
const mappingSha256 = mappingBytes ? createHash("sha256").update(mappingBytes).digest("hex") : null;
const mapping = mappingBytes ? JSON.parse(mappingBytes.toString("utf8")) as LeadershipMapping : undefined;
const report = preflightOrganizationImport(organizationRows, ledgerPeople, ledgerUnits, mapping,ledgerRows,HISTORICAL_ORGANIZATION_BASELINE);
const output = {
  sourceFile:path.basename(sourceFile),
  sourceSha256,
  mappingFile:mappingFile ? path.basename(mappingFile) : null,
  mappingSha256,
  ...report,
};
if (process.argv.includes("--apply")) {
  if (!mapping || !mappingFile || !mappingSha256 || !report.ready) {
    console.log(JSON.stringify(output,null,2));
    process.exitCode=2;
  } else if (argument("--confirm-source-sha256")!==sourceSha256 || argument("--confirm-mapping-sha256")!==mappingSha256) {
    console.log(JSON.stringify({ ...output,ready:false,blockers:[...report.blockers,"确认哈希与预检结果不一致"] },null,2));
    process.exitCode=2;
  } else {
    try {
      const applied = await applyOrganizationImport(db,{
        sourceFile:path.basename(sourceFile),sourceSha256,mappingFile:path.basename(mappingFile),mappingSha256,
        organizationRows,ledgerRows,mapping,expectedBaseline:HISTORICAL_ORGANIZATION_BASELINE,
      });
      console.log(JSON.stringify({ ...output,...applied },null,2));
    } finally {
      await db.end();
    }
  }
} else {
  console.log(JSON.stringify(output, null, 2));
  if (!report.ready) process.exitCode = 2;
}
