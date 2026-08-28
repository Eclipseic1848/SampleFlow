import { db } from "../db.js";
import { confirmImportBatch } from "../services/import-job.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const batchId = argument("--batch-id") ?? process.env.IMPORT_BATCH_ID;
const operatorUserId = argument("--operator-user-id") ?? process.env.IMPORT_OPERATOR_USER_ID;
const warnings = (argument("--confirm-warnings") ?? process.env.IMPORT_CONFIRMED_WARNINGS ?? "").split(",").filter(Boolean);
if (!batchId || !operatorUserId) {
  throw new Error("用法：import:confirm -- --batch-id <预检批次> --operator-user-id <销售助理组长> [--confirm-warnings <来源行号:警告代码,来源行号:警告代码>]");
}
try {
  const result = await confirmImportBatch(db, batchId, operatorUserId, warnings);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.end();
}
