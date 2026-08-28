import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../db.js";
import { parseImportWorkbook, type ImportLayout } from "../domain/performance-import-xlsx.js";
import { preflightImportRows } from "../services/import-job.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceArgument = argument("--source") ?? process.env.IMPORT_SOURCE_FILE;
const configId = argument("--config-id") ?? process.env.IMPORT_CONFIG_ID;
const operatorUserId = argument("--operator-user-id") ?? process.env.IMPORT_OPERATOR_USER_ID;
if (!sourceArgument || !configId || !operatorUserId) {
  throw new Error("用法：import:preflight -- --source <xlsx> --config-id <已批准配置> --operator-user-id <操作人>");
}
const sourceFile = path.resolve(process.env.INIT_CWD ?? process.cwd(), sourceArgument);
const bytes = await readFile(sourceFile);
try {
  const config = await db.query<{
    sheet_name: string;
    expected_headers: unknown[];
    column_mapping: ImportLayout["columnMapping"];
    person_mapping: Record<string, string>;
    fixed_event_type: "legacy_adjustment" | null;
  }>("select sheet_name,expected_headers,column_mapping,person_mapping,fixed_event_type from import_configs where id=$1 and status='approved'", [configId]);
  if (!config.rows[0]) throw new Error("只能使用已批准的导入配置");
  const rows = await parseImportWorkbook(path.basename(sourceFile), bytes, {
    sheetName: config.rows[0].sheet_name,
    expectedHeaders: config.rows[0].expected_headers,
    columnMapping: config.rows[0].column_mapping,
    personMapping: config.rows[0].person_mapping,
    ...(config.rows[0].fixed_event_type ? { fixedEventType: config.rows[0].fixed_event_type } : {}),
  });
  const report = await preflightImportRows(db, {
    actorUserId: operatorUserId,
    configId,
    sourceFileName: path.basename(sourceFile),
    sourceBytes: bytes,
    rows,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "blocked") process.exitCode = 2;
} finally {
  await db.end();
}
