import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readXlsxFile from "read-excel-file/node";
import { db } from "../db.js";

type SourceRow = {
  rowNumber: number;
  date: Date;
  orderNo: string;
  customerName: string;
  customerUnit: string;
  salespersonName: string;
  departmentName: string;
  groupName: string;
  amount: number;
  serviceType: string;
  reason: string;
};

const sourceFile = path.resolve(import.meta.dirname, "../../../../原始数据1.xlsx");
const bytes = await readFile(sourceFile);
const sourceHash = createHash("sha256").update(bytes).digest("hex");
const sheets = await readXlsxFile(sourceFile) as unknown as Array<{ sheet: string; data: unknown[][] }>;
const sheet = sheets.find((candidate) => candidate.sheet === "分子");
if (!sheet) throw new Error("原始数据1.xlsx 缺少“分子”工作表");

const sourceRows: SourceRow[] = sheet.data.slice(1).flatMap((row, index) => {
  const date = row[1];
  const orderNo = row[2];
  const amount = row[9];
  if (!(date instanceof Date) || typeof orderNo !== "string" || typeof amount !== "number") return [];
  return [{
    rowNumber: index + 2,
    date,
    orderNo: orderNo.trim(),
    customerName: typeof row[3] === "string" && row[3].trim() ? row[3].trim() : "未填写",
    customerUnit: typeof row[4] === "string" && row[4].trim() ? row[4].trim() : "未填写",
    salespersonName: typeof row[6] === "string" && row[6].trim() ? row[6].trim() : "未填写",
    departmentName: typeof row[7] === "string" && row[7].trim() ? row[7].trim() : "未填写",
    groupName: typeof row[8] === "string" && row[8].trim() ? row[8].trim() : "未填写",
    amount: Math.round((amount + Number.EPSILON) * 100) / 100,
    serviceType: typeof row[10] === "string" ? row[10].trim() : "",
    reason: typeof row[11] === "string" && row[11].trim() ? row[11].trim() : "历史明细迁移",
  }];
});

const grouped = new Map<string, SourceRow[]>();
for (const row of sourceRows) {
  const rows = grouped.get(row.orderNo) ?? [];
  rows.push(row);
  grouped.set(row.orderNo, rows);
}

const client = await db.connect();
try {
  await client.query("begin");
  const imported = await client.query("select 1 from legacy_import_runs where source_sha256 = $1", [sourceHash]);
  if (imported.rowCount) {
    await client.query("rollback");
    console.log(`[迁移] 已导入同一版本：${path.basename(sourceFile)}，无需重复执行`);
  } else {
    let orderCount = 0;
    let eventCount = 0;
    for (const [orderNo, rows] of grouped) {
      rows.sort((left, right) => left.date.getTime() - right.date.getTime() || left.rowNumber - right.rowNumber);
      const first = rows[0]!;
      const total = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
      const last = rows.at(-1)!;
      const lastPause = last.amount < 0 && last.reason.includes("暂停");
      const lifecycle = total > 0 ? "active" : lastPause || total < 0 ? "paused" : "zero";
      const currentRevenue = lifecycle === "active" ? total : lifecycle === "paused" ? Math.abs(last.amount) : 0;
      const order = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no, customer_name, customer_unit, salesperson_name, service_type, source_received_on,
           original_amount, current_revenue, counted_amount, lifecycle_state, posted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         on conflict (qingflow_order_no) do nothing returning id::text`,
        [orderNo, first.customerName, first.customerUnit, last.salespersonName, first.serviceType || null,
         first.date, Math.max(0, first.amount), currentRevenue, total, lifecycle],
      );
      if (!order.rows[0]) continue;
      orderCount += 1;
      let running = 0;
      let runningRevenue = Math.max(0, first.amount);
      for (const row of rows) {
        running = Math.round((running + row.amount) * 100) / 100;
        if (row.amount > 0) runningRevenue = row.amount;
        if (row.amount < 0 && row.reason.includes("暂停")) runningRevenue = Math.abs(row.amount);
        await client.query(
          `insert into performance_events
            (order_id, event_type, delta_amount, resulting_current_revenue, resulting_counted_amount,
             accounting_month, occurred_on, reason, salesperson_name, department_name, group_name, source_row_number)
           values ($1, 'legacy_adjustment', $2, $3, $4, date_trunc('month', $5::date)::date,
                   $5, $6, $7, $8, $9, $10)`,
          [order.rows[0]!.id, row.amount, Math.max(0, runningRevenue), running, row.date,
           row.reason, row.salespersonName, row.departmentName, row.groupName, row.rowNumber],
        );
        eventCount += 1;
      }
    }
    await client.query(
      `insert into legacy_import_runs (source_file, source_sha256, source_rows, imported_orders, imported_events)
       values ($1,$2,$3,$4,$5)`,
      [path.basename(sourceFile), sourceHash, sourceRows.length, orderCount, eventCount],
    );
    await client.query("commit");
    console.log(`[迁移] ${sourceRows.length} 行已迁移为 ${orderCount} 笔订单、${eventCount} 条不可变事件`);
  }
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  client.release();
  await db.end();
}
