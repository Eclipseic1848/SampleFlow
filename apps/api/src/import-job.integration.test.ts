import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { confirmImportBatch, preflightImportRows, type ImportSourceRow } from "./services/import-job.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Pool } = pg;

async function fixture(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query("insert into roles(code,name) values('sales_assistant_leader','销售助理组长')");
  const user = await pool.query<{ id: string }>(
    "insert into users(username,display_name,password_hash,password_salt) values('importer','导入人','x','x') returning id::text",
  );
  const approver = await pool.query<{ id: string }>(
    "insert into users(username,display_name,password_hash,password_salt) values('approver','审批人','x','x') returning id::text",
  );
  await pool.query("insert into user_roles(user_id,role_code) values($1,'sales_assistant_leader')", [user.rows[0]!.id]);
  const people = await pool.query<{ id: string; display_name: string }>(
    "insert into people(display_name,identity_source,source_key) values('业务员甲','fixture','person:a'),('组长甲','fixture','leader:a'),('主管甲','fixture','supervisor:a') returning id::text,display_name",
  );
  const id = (name: string) => people.rows.find((row) => row.display_name === name)!.id;
  const department = await pool.query<{ id: string }>("insert into org_units(name,unit_type) values('销售一部','department') returning id::text");
  const group = await pool.query<{ id: string }>("insert into org_units(name,unit_type,parent_id) values('一组','group',$1) returning id::text", [department.rows[0]!.id]);
  await pool.query("insert into org_responsibilities(person_id,org_unit_id,responsibility_type,effective_from) values($1,$2,'leader','2026-01-01'),($3,$4,'supervisor','2026-01-01')", [id("组长甲"), group.rows[0]!.id, id("主管甲"), department.rows[0]!.id]);
  await pool.query("insert into org_memberships(person_id,department_id,group_id,effective_from) values($1,$2,$3,'2026-01-01')", [id("业务员甲"), department.rows[0]!.id, group.rows[0]!.id]);
  const config = await pool.query<{ id: string }>(
    `insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,business_region_mapping,allowed_event_types,created_by,approved_by,approved_at)
     values('custom',1,'自定义业绩模板','approved','业绩导入','[]','{}','{"江苏省":"CN-JS"}','["initial","revenue_change","pause","restart","first_include"]',$1,$2,now()) returning id::text`,
    [user.rows[0]!.id, approver.rows[0]!.id],
  );
  return {
    pool,
    actorUserId: user.rows[0]!.id,
    configId: config.rows[0]!.id,
    salespersonPersonId: id("业务员甲"),
    leaderPersonId: id("组长甲"),
  };
}

function row(overrides: Partial<Omit<ImportSourceRow, "sourceRecordId">> & { sourceRecordId?: string | undefined } = {}): ImportSourceRow {
  const merged = {
    sheet: "业绩导入",
    rowNumber: 2,
    sourceRecordId: "SRC-001",
    orderNo: "001-A",
    occurredOn: "2026-03-05",
    customerName: "客户甲",
    customerUnit: "单位甲",
    businessRegionSourceText: "江苏省",
    salespersonSourceKey: "person:a",
    serviceType: "检测",
    eventType: "initial",
    amount: 100,
    reason: "首次转录",
    ...overrides,
  };
  const { sourceRecordId, ...required } = merged;
  return sourceRecordId === undefined ? required : { ...required, sourceRecordId };
}

async function legacyConfig(pool: pg.Pool): Promise<string> {
  const config = await pool.query<{ id: string }>(
    `insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,
       business_region_mapping,allowed_event_types,fixed_event_type,allow_legacy_source_key,approved_at)
     values('legacy',1,'历史格式','approved','分子','[]','{}','{"江苏省":"CN-JS"}',
       '["legacy_adjustment"]','legacy_adjustment',true,now()) returning id::text`,
  );
  return config.rows[0]!.id;
}

test("标准业绩模板只能导入首次入账事件", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const standard = await context.pool.query<{ id: string }>(
        `update import_configs set status='approved',business_region_mapping='{"江苏省":"CN-JS"}',approved_at=now()
         where config_key='standard-performance' returning id::text`,
      );
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: standard.rows[0]!.id,
        sourceFileName: "standard-adjustment.xlsx", sourceBytes: Buffer.from("standard-adjustment"),
        rows: [row({ eventType: "revenue_change", amount: 90 })],
      });
      assert.equal(preflight.status, "blocked");
      assert.ok(preflight.issues.some((issue) => issue.code === "EVENT_TYPE_NOT_ALLOWED"));
    } finally { await context.pool.end(); }
  });
});

test("批次内订单基础事实冲突列出具体字段", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "fact-conflict.xlsx", sourceBytes: Buffer.from("fact-conflict"),
        rows: [row(), row({ rowNumber: 3, sourceRecordId: "SRC-002", customerName: "客户乙" })],
      });
      const issue = preflight.issues.find((item) => item.code === "ORDER_FACT_CONFLICT");
      assert.match(issue?.message ?? "", /customerName/);
    } finally { await context.pool.end(); }
  });
});

test("单条业务事件不能使用跳号业务顺序", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "sequence-99.xlsx", sourceBytes: Buffer.from("sequence-99"),
        rows: [row({ businessSequence: 99 })],
      });
      assert.ok(preflight.issues.some((issue) => issue.code === "BUSINESS_SEQUENCE_REQUIRED"));
    } finally { await context.pool.end(); }
  });
});

test("关闭期间导入必须锁定并消费匹配的一次性更正授权", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const initial = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "closed-initial.xlsx", sourceBytes: Buffer.from("closed-initial"), rows: [row()],
      });
      await confirmImportBatch(context.pool, initial.batchId, context.actorUserId, []);
      const order = await context.pool.query<{ id: string }>("select id::text from performance_orders where qingflow_order_no='001-A'");
      await context.pool.query("update accounting_periods set status='closed' where period_month='2026-03-01'");
      const correction = await context.pool.query<{ id: string }>(
        `insert into accounting_correction_requests(period_month,order_id,event_type,occurred_on,reason,
           requested_by_user_id,requested_by_person_id,requested_at,status,reviewed_by_user_id,reviewed_by_person_id,reviewed_at,expires_at)
         select '2026-03-01',$1,'revenue_change','2026-03-06','获批导入更正',$2,requester_person.id,
                now(),'approved',approver.id,approver_person.id,now(),now()+interval '24 hours'
         from users requester join people requester_person on requester_person.user_id=requester.id,
              users approver join people approver_person on approver_person.user_id=approver.id
         where requester.id=$2 and approver.username='approver' returning id::text`,
        [order.rows[0]!.id, context.actorUserId],
      );
      const adjustment = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "closed-adjustment.xlsx", sourceBytes: Buffer.from("closed-adjustment"),
        rows: [row({ rowNumber: 2, sourceRecordId: "SRC-002", occurredOn: "2026-03-06", eventType: "revenue_change", amount: 90, correctionRequestId: Number(correction.rows[0]!.id) })],
      });
      assert.equal(adjustment.status, "preflight_ready");
      await confirmImportBatch(context.pool, adjustment.batchId, context.actorUserId, []);
      const state = await context.pool.query<{ status: string; consumed_event_id: string | null }>("select status,consumed_event_id::text from accounting_correction_requests where id=$1", [correction.rows[0]!.id]);
      assert.equal(state.rows[0]!.status, "consumed");
      assert.ok(state.rows[0]!.consumed_event_id);
    } finally { await context.pool.end(); }
  });
});

test("重新上传原始历史文件时关联既有事件并补齐区域但不改写旧事件", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const configId = await legacyConfig(context.pool);
      const sourceBytes = Buffer.from("original-legacy-workbook");
      const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
      const order = await context.pool.query<{ id: string }>(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,service_type,
           source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,salesperson_person_id,posted_at)
         values('001-A','客户甲','单位甲','业务员甲','检测','2026-03-05',100,100,100,'active',$1,now()) returning id::text`,
        [context.salespersonPersonId],
      );
      const event = await context.pool.query<{ id: string }>(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number,
           salesperson_person_id)
         values($1,'legacy_adjustment',100,100,100,'2026-03-01','2026-03-05','首次转录','业务员甲','销售一部','一组',2,
           $2) returning id::text`,
        [order.rows[0]!.id, context.salespersonPersonId],
      );
      await context.pool.query(
        `insert into legacy_event_source_evidence(event_id,source_file_sha256,source_sheet,source_row_number,source_key)
         values($1,$2,'分子',2,$3)`,
        [event.rows[0]!.id, sourceHash, `legacy:${sourceHash}:分子:2`],
      );
      const mismatch = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId,
        sourceFileName: "原始数据1-服务类型冲突.xlsx", sourceBytes,
        rows: [row({ sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment", serviceType: "其他服务" })],
      });
      assert.equal(mismatch.status, "blocked");
      assert.ok(mismatch.issues.some((issue) => issue.code === "ORDER_FACT_CONFLICT" && issue.message.includes("serviceType")));
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId,
        sourceFileName: "原始数据1.xlsx", sourceBytes,
        rows: [row({ sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment" })],
      });
      assert.equal(preflight.status, "preflight_ready");
      assert.equal(preflight.summary.reconciliations, 1);
      assert.ok(preflight.issues.some((issue) => issue.code === "LEGACY_EVENT_RECONCILIATION"));
      const confirmed = await confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, []);
      assert.equal(confirmed.events, 0);
      assert.equal(confirmed.reconciliations, 1);
      const evidence = await context.pool.query<{
        event_id: string; batch_id: string; reconciled_by: string; source_operator_status: string;
        business_region_source_text: string; business_region_code: string; import_batch_id: string | null; event_count: number;
      }>(
        `select reconciliation.event_id::text,reconciliation.batch_id::text,reconciliation.reconciled_by::text,
                reconciliation.source_operator_status,performance_order.business_region_source_text,
                performance_order.business_region_code,event.import_batch_id::text,
                (select count(*)::int from performance_events) event_count
         from legacy_event_import_reconciliations reconciliation
         join performance_events event on event.id=reconciliation.event_id
         join performance_orders performance_order on performance_order.id=event.order_id`,
      );
      assert.deepEqual(evidence.rows[0], {
        event_id: event.rows[0]!.id, batch_id: preflight.batchId, reconciled_by: context.actorUserId,
        source_operator_status: "unknown", business_region_source_text: "江苏省", business_region_code: "CN-JS",
        import_batch_id: null, event_count: 1,
      });
      const replay = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId,
        sourceFileName: "原始数据1-再次核对.xlsx", sourceBytes,
        rows: [row({ sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment" })],
      });
      assert.equal(replay.summary.events, 0);
      assert.equal(replay.summary.reconciliations, 0);
      assert.ok(replay.issues.some((issue) => issue.code === "SOURCE_RECORD_ALREADY_IMPORTED"));
      await confirmImportBatch(context.pool, replay.batchId, context.actorUserId, []);
    } finally { await context.pool.end(); }
  });
});

test("预检只写批次证据，不写正式账本；确认原子入账且重复确认不增量", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "standard.xlsx",
        sourceBytes: Buffer.from("synthetic-standard"),
        rows: [row()],
      });
      assert.equal(preflight.status, "preflight_ready");
      assert.deepEqual(preflight.summary, { rows: 1, orders: 1, events: 1, reconciliations: 0, totalAmount: 100, blocking: 0, warnings: 0 });
      const before = await context.pool.query("select (select count(*) from performance_orders)::int orders,(select count(*) from performance_events)::int events");
      assert.deepEqual(before.rows[0], { orders: 0, events: 0 });

      const confirmed = await confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, []);
      assert.equal(confirmed.replayed, false);
      const replay = await confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, []);
      assert.equal(replay.replayed, true);
      const repeatedFile = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "standard-copy.xlsx",
        sourceBytes: Buffer.from("synthetic-standard"),
        rows: [row()],
      });
      assert.equal(repeatedFile.summary.events, 0);
      assert.equal(repeatedFile.summary.warnings, 0);
      assert.ok(repeatedFile.issues.some((issue) => issue.code === "SOURCE_RECORD_ALREADY_IMPORTED" && issue.severity === "info"));
      await confirmImportBatch(context.pool, repeatedFile.batchId, context.actorUserId, []);
      const totals = await context.pool.query("select (select count(*) from performance_orders)::int orders,(select count(*) from performance_events)::int events,(select sum(delta_amount)::numeric from performance_events)::text total");
      assert.deepEqual(totals.rows[0], { orders: 1, events: 1, total: "100.00" });
    } finally {
      await context.pool.end();
    }
  });
});

test("相同稳定来源标识的载荷变化必须阻断而不能静默跳过", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "source-original.xlsx",
        sourceBytes: Buffer.from("source-original"),
        rows: [row()],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);

      const changed = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "source-changed.xlsx",
        sourceBytes: Buffer.from("source-changed"),
        rows: [row({ customerName: "客户乙" })],
      });
      assert.equal(changed.status, "blocked");
      assert.ok(changed.issues.some((issue) => issue.code === "SOURCE_RECORD_CONFLICT"));
      const count = await context.pool.query<{ count: number }>("select count(*)::int count from performance_events");
      assert.equal(count.rows[0]!.count, 1);
    } finally {
      await context.pool.end();
    }
  });
});

test("导入配置升级后相同稳定来源标识仍保持幂等", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "config-v1.xlsx", sourceBytes: Buffer.from("config-v1"), rows: [row()],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      const secondConfig = await context.pool.query<{ id: string }>(
        `insert into import_configs(config_key,version,name,status,sheet_name,expected_headers,column_mapping,business_region_mapping,approved_at)
         values('custom',2,'自定义业绩模板 v2','approved','业绩导入','[]','{}','{"江苏省":"CN-JS"}',now()) returning id::text`,
      );
      const repeated = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: secondConfig.rows[0]!.id,
        sourceFileName: "config-v2.xlsx", sourceBytes: Buffer.from("config-v2"), rows: [row()],
      });
      assert.equal(repeated.status, "preflight_ready");
      assert.equal(repeated.summary.events, 0);
      assert.ok(repeated.issues.some((issue) => issue.code === "SOURCE_RECORD_ALREADY_IMPORTED"));
    } finally {
      await context.pool.end();
    }
  });
});

test("升级前旧事件在换文件重放时仍被识别为跨文件疑似重复", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const configId = await legacyConfig(context.pool);
      const order = await context.pool.query<{ id: string }>(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
           salesperson_person_id,salesperson_name,service_type,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('001-A','客户甲','单位甲','江苏省','CN-JS',$1,'业务员甲','检测','2026-03-05',100,100,100,'active',now()) returning id::text`,
        [context.salespersonPersonId],
      );
      await context.pool.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_person_id,salesperson_name,department_name,group_name,
           source_file_sha256,source_sheet,source_row_number,source_key)
         values($1,'legacy_adjustment',100,100,100,'2026-03-01','2026-03-05','首次转录',$2,'业务员甲','销售一部','一组',
           'old-file-hash','分子',2,'legacy:old-file-hash:分子:2')`,
        [order.rows[0]!.id, context.salespersonPersonId],
      );

      const repeated = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId,
        sourceFileName: "legacy-resaved.xlsx",
        sourceBytes: Buffer.from("legacy-resaved"),
        rows: [row({ sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment" })],
      });
      assert.equal(repeated.status, "blocked");
      assert.ok(repeated.issues.some((issue) => issue.code === "CROSS_FILE_DUPLICATE_CANDIDATE"));
    } finally {
      await context.pool.end();
    }
  });
});

test("预检作业使用数据库锁串行保存批次证据", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    const blocker = await context.pool.connect();
    let preflightFinished = false;
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtext('sampleflow:performance-import-preflight'))");
      const running = preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "locked-preflight.xlsx",
        sourceBytes: Buffer.from("locked-preflight"),
        rows: [row()],
      }).finally(() => { preflightFinished = true; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(preflightFinished, false);
      await blocker.query("rollback");
      await running;
    } finally {
      if (!preflightFinished) await blocker.query("rollback");
      blocker.release();
      await context.pool.end();
    }
  });
});

test("数据库拒绝篡改或删除导入来源证据", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "immutable-source.xlsx",
        sourceBytes: Buffer.from("immutable-source"),
        rows: [row()],
      });
      await assert.rejects(
        context.pool.query("update import_batches set source_bytes=$2 where id=$1", [preflight.batchId, Buffer.from("tampered")]),
        /导入来源证据不可修改/,
      );
      await assert.rejects(
        context.pool.query("delete from import_batch_rows where batch_id=$1", [preflight.batchId]),
        /导入批次行证据不可更新或删除/,
      );
      await assert.rejects(
        context.pool.query("delete from import_batches where id=$1", [preflight.batchId]),
        /导入来源证据不可删除/,
      );
      await assert.rejects(
        context.pool.query("update import_configs set name='被篡改' where id=$1", [context.configId]),
        /已产生导入批次的配置定义不可修改/,
      );
      await confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, []);
    } finally {
      await context.pool.end();
    }
  });
});

test("已产生批次的导入配置身份与审批证据不可修改", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "used-config.xlsx", sourceBytes: Buffer.from("used-config"), rows: [row()],
      });
      for (const statement of [
        "update import_configs set config_key='changed-key' where id=$1",
        "update import_configs set version=99 where id=$1",
        "update import_configs set created_by=null where id=$1",
        "update import_configs set approved_at=approved_at+interval '1 second' where id=$1",
      ]) {
        await assert.rejects(context.pool.query(statement, [context.configId]), /配置定义不可修改/);
      }
    } finally { await context.pool.end(); }
  });
});

test("预检一次返回全部行级阻断且阻断批次不可确认", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "invalid.xlsx",
        sourceBytes: Buffer.from("synthetic-invalid"),
        rows: [row({ orderNo: " 001-A", occurredOn: "2026-02-31", amount: 1.001, businessRegionSourceText: "未知省", sourceRecordId: "SRC-002" })],
      });
      assert.equal(preflight.status, "blocked");
      assert.ok(preflight.issues.some((issue) => issue.message.includes("订单编号")));
      assert.ok(preflight.issues.some((issue) => issue.message.includes("发生日期")));
      assert.ok(preflight.issues.some((issue) => issue.message.includes("金额")));
      assert.ok(preflight.issues.some((issue) => issue.message.includes("业务区域")));
      await assert.rejects(confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, []), /存在阻断错误/);
    } finally {
      await context.pool.end();
    }
  });
});

test("预检一次汇总 Excel 行的全部文本与事件类型错误", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "invalid-text-fields.xlsx",
        sourceBytes: Buffer.from("invalid-text-fields"),
        rows: [row({
          sourceRecordId: "S".repeat(201),
          customerName: "",
          customerUnit: "单".repeat(301),
          serviceType: "服".repeat(201),
          reason: "因".repeat(501),
          eventType: "unsupported",
        })],
      });
      const codes = new Set(preflight.issues.map((issue) => issue.code));
      assert.deepEqual(
        [...["SOURCE_RECORD_ID_INVALID", "CUSTOMER_NAME_INVALID", "CUSTOMER_UNIT_INVALID", "SERVICE_TYPE_INVALID", "REASON_INVALID", "EVENT_TYPE_INVALID"].filter((code) => !codes.has(code))],
        [],
      );
    } finally {
      await context.pool.end();
    }
  });
});

test("导入配置版本中的必填规则参与预检", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      await context.pool.query("update import_configs set required_columns='[\"reason\"]'::jsonb where id=$1", [context.configId]);
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "required-rule.xlsx",
        sourceBytes: Buffer.from("required-rule"),
        rows: [row({ reason: "" })],
      });
      assert.equal(preflight.status, "blocked");
      assert.ok(preflight.issues.some((issue) => issue.code === "REQUIRED_FIELD_MISSING" && issue.message.includes("reason")));
    } finally {
      await context.pool.end();
    }
  });
});

test("普通配置不能把标准行伪装为历史事件绕过期间规则", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "forged-legacy.xlsx",
        sourceBytes: Buffer.from("forged-legacy"),
        rows: [row({ eventType: "legacy_adjustment" })],
      });
      assert.equal(preflight.status, "blocked");
      assert.ok(preflight.issues.some((issue) => issue.code === "LEGACY_EVENT_NOT_ALLOWED"));
    } finally {
      await context.pool.end();
    }
  });
});

test("专用历史配置不能绕过已经关闭的记账期间", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const configId = await legacyConfig(context.pool);
      await context.pool.query("insert into accounting_periods(period_month,status) values('2026-03-01','closed')");
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId,
        sourceFileName: "legacy-closed-period.xlsx",
        sourceBytes: Buffer.from("legacy-closed-period"),
        rows: [row({ sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment" })],
      });
      assert.equal(preflight.status, "blocked");
      assert.ok(preflight.issues.some((issue) => issue.code === "CLOSED_PERIOD_AUTHORIZATION_REQUIRED"));
      const count = await context.pool.query<{ count: number }>("select count(*)::int count from performance_events");
      assert.equal(count.rows[0]!.count, 0);
    } finally {
      await context.pool.end();
    }
  });
});

test("所有导入配置接受当前停用但发生日任职有效的人员", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const configId = await legacyConfig(context.pool);
      await context.pool.query("update people set is_active=false where id=$1", [context.salespersonPersonId]);
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId,
        sourceFileName: "legacy-inactive-person.xlsx",
        sourceBytes: Buffer.from("legacy-inactive-person"),
        rows: [row({ sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment" })],
      });
      assert.equal(preflight.status, "preflight_ready");
      assert.equal(preflight.summary.events, 1);
      assert.ok(!preflight.issues.some((issue) => issue.code === "PERSON_NOT_FOUND"));
      const standardPreflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "standard-inactive-person.xlsx",
        sourceBytes: Buffer.from("standard-inactive-person"),
        rows: [row({ sourceRecordId: "SRC-INACTIVE-STANDARD" })],
      });
      assert.equal(standardPreflight.status, "preflight_ready");
      assert.equal(standardPreflight.summary.events, 1);
      assert.ok(!standardPreflight.issues.some((issue) => issue.code === "PERSON_NOT_FOUND"));
    } finally {
      await context.pool.end();
    }
  });
});

test("已有订单不能通过新的来源记录再次追加 initial", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "first.xlsx",
        sourceBytes: Buffer.from("first"),
        rows: [row()],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      const repeatedInitial = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "second.xlsx",
        sourceBytes: Buffer.from("second"),
        rows: [row({ sourceRecordId: "SRC-NEW", amount: 200 })],
      });
      assert.equal(repeatedInitial.status, "blocked");
      assert.ok(repeatedInitial.issues.some((issue) => issue.code === "INITIAL_ORDER_ALREADY_EXISTS"));
      assert.ok(repeatedInitial.issues.some((issue) => issue.code === "ORDER_FACT_CONFLICT" && issue.message.includes("originalAmount")));
    } finally {
      await context.pool.end();
    }
  });
});

test("订单编号大小写或全半角变体必须在预检阻断", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "canonical-order.xlsx",
        sourceBytes: Buffer.from("canonical-order"),
        rows: [row()],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      const variant = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "variant-order.xlsx",
        sourceBytes: Buffer.from("variant-order"),
        rows: [row({ sourceRecordId: "SRC-VARIANT", orderNo: "００１-a" })],
      });
      assert.equal(variant.status, "blocked");
      assert.ok(variant.issues.some((issue) => issue.code === "ORDER_NO_VARIANT"));
    } finally {
      await context.pool.end();
    }
  });
});

test("同日多事件要求连续业务顺序并按人工规则预演后入账", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const initial = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "event-chain-initial.xlsx", sourceBytes: Buffer.from("event-chain-initial"), rows: [row({ businessSequence: 1 })],
      });
      await confirmImportBatch(context.pool, initial.batchId, context.actorUserId, []);
      const unorderedRows = [
        row({ rowNumber: 2, sourceRecordId: "CHAIN-CHANGE", eventType: "revenue_change", amount: 80 }),
        row({ rowNumber: 3, sourceRecordId: "CHAIN-PAUSE", eventType: "pause", amount: 0 }),
      ];
      const unordered = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "event-chain-unordered.xlsx", sourceBytes: Buffer.from("event-chain-unordered"), rows: unorderedRows,
      });
      assert.equal(unordered.status, "blocked");
      assert.ok(unordered.issues.some((issue) => issue.code === "BUSINESS_SEQUENCE_REQUIRED"));

      const ordered = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "event-chain-ordered.xlsx", sourceBytes: Buffer.from("event-chain-ordered"),
        rows: unorderedRows.map((item, index) => ({ ...item, businessSequence: index + 2 })),
      });
      assert.equal(ordered.status, "preflight_ready");
      await confirmImportBatch(context.pool, ordered.batchId, context.actorUserId, []);
      const events = await context.pool.query<{ event_type:string; delta_amount:string }>(
        "select event_type,delta_amount::text from performance_events order by order_sequence",
      );
      assert.deepEqual(events.rows, [
        { event_type:"initial", delta_amount:"100.00" },
        { event_type:"revenue_change", delta_amount:"-20.00" },
        { event_type:"pause", delta_amount:"-80.00" },
      ]);
    } finally {
      await context.pool.end();
    }
  });
});

test("同一批次的一个订单只能包含一条 initial", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "two-initials.xlsx",
        sourceBytes: Buffer.from("two-initials"),
        rows: [row(), row({ rowNumber: 3, sourceRecordId: "SRC-002" })],
      });
      assert.equal(preflight.status, "blocked");
      assert.ok(preflight.issues.some((issue) => issue.code === "MULTIPLE_INITIAL_EVENTS"));
    } finally {
      await context.pool.end();
    }
  });
});

test("两个并发预检在确认锁内重新识别跨文件重复候选", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "concurrent-a.xlsx",
        sourceBytes: Buffer.from("concurrent-a"),
        rows: [row({ sourceRecordId: "SRC-A" })],
      });
      const second = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "concurrent-b.xlsx",
        sourceBytes: Buffer.from("concurrent-b"),
        rows: [row({ sourceRecordId: "SRC-B" })],
      });
      assert.equal(first.status, "preflight_ready");
      assert.equal(second.status, "preflight_ready");
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      await assert.rejects(
        confirmImportBatch(context.pool, second.batchId, context.actorUserId, []),
        /跨文件疑似重复/,
      );
      const count = await context.pool.query<{ count: number }>("select count(*)::int count from performance_events");
      assert.equal(count.rows[0]!.count, 1);
    } finally {
      await context.pool.end();
    }
  });
});

test("两个并发预检的相同来源键在确认锁内自动幂等跳过", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const input = (sourceFileName: string, sourceBytes: Buffer) => ({
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName,
        sourceBytes,
        rows: [row()],
      });
      const first = await preflightImportRows(context.pool, input("same-a.xlsx", Buffer.from("same-a")));
      const second = await preflightImportRows(context.pool, input("same-b.xlsx", Buffer.from("same-b")));
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      const skipped = await confirmImportBatch(context.pool, second.batchId, context.actorUserId, []);
      assert.equal(skipped.events, 0);
      const count = await context.pool.query<{ count: number }>("select count(*)::int count from performance_events");
      assert.equal(count.rows[0]!.count, 1);
    } finally {
      await context.pool.end();
    }
  });
});

test("两个并发预检的相同来源键载荷不同时在确认锁内阻断", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "same-source-a.xlsx", sourceBytes: Buffer.from("same-source-a"), rows: [row()],
      });
      const second = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "same-source-b.xlsx", sourceBytes: Buffer.from("same-source-b"), rows: [row({ amount: 200 })],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      await assert.rejects(
        confirmImportBatch(context.pool, second.batchId, context.actorUserId, []),
        /来源记录.*载荷.*不一致/,
      );
      const totals = await context.pool.query<{ events: number; total: string }>(
        "select count(*)::int events,sum(delta_amount)::text total from performance_events",
      );
      assert.deepEqual(totals.rows[0], { events: 1, total: "100.00" });
    } finally {
      await context.pool.end();
    }
  });
});

test("确认时重新校验并发批次，拒绝在已入账的更晚事件之前追加", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const initial = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "race-order-initial.xlsx", sourceBytes: Buffer.from("race-order-initial"), rows: [row()],
      });
      await confirmImportBatch(context.pool, initial.batchId, context.actorUserId, []);
      const earlier = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "race-order-earlier.xlsx", sourceBytes: Buffer.from("race-order-earlier"),
        rows: [row({ rowNumber: 2, sourceRecordId: "RACE-EARLIER", occurredOn: "2026-03-06", eventType: "revenue_change", amount: 90, reason: "较早调整" })],
      });
      const later = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "race-order-later.xlsx", sourceBytes: Buffer.from("race-order-later"),
        rows: [row({ rowNumber: 2, sourceRecordId: "RACE-LATER", occurredOn: "2026-03-07", eventType: "revenue_change", amount: 80, reason: "较晚调整" })],
      });
      assert.equal(earlier.status, "preflight_ready");
      assert.equal(later.status, "preflight_ready");
      await confirmImportBatch(context.pool, later.batchId, context.actorUserId, []);
      await assert.rejects(
        confirmImportBatch(context.pool, earlier.batchId, context.actorUserId, []),
        /已有业务事件之前|事件顺序.*变化|重新预检/,
      );
      const dates = await context.pool.query<{ occurred_on: string }>("select occurred_on::text from performance_events order by order_sequence");
      assert.deepEqual(dates.rows.map((item) => String(item.occurred_on).slice(0, 10)), ["2026-03-05", "2026-03-07"]);
    } finally { await context.pool.end(); }
  });
});

test("确认时重新校验并发批次，拒绝同日重复业务顺序", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const initial = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "race-sequence-initial.xlsx", sourceBytes: Buffer.from("race-sequence-initial"),
        rows: [row({ businessSequence: 1 })],
      });
      await confirmImportBatch(context.pool, initial.batchId, context.actorUserId, []);
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "race-sequence-a.xlsx", sourceBytes: Buffer.from("race-sequence-a"),
        rows: [row({ sourceRecordId: "RACE-SEQUENCE-A", businessSequence: 2, eventType: "revenue_change", amount: 90, reason: "并发调整甲" })],
      });
      const second = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "race-sequence-b.xlsx", sourceBytes: Buffer.from("race-sequence-b"),
        rows: [row({ sourceRecordId: "RACE-SEQUENCE-B", businessSequence: 2, eventType: "revenue_change", amount: 80, reason: "并发调整乙" })],
      });
      assert.equal(first.status, "preflight_ready");
      assert.equal(second.status, "preflight_ready");
      await confirmImportBatch(context.pool, second.batchId, context.actorUserId, []);
      await assert.rejects(confirmImportBatch(context.pool, first.batchId, context.actorUserId, []), /业务顺序|重新预检/);
      const events = await context.pool.query<{ source_business_sequence: number }>("select source_business_sequence from performance_events order by order_sequence");
      assert.deepEqual(events.rows.map((item) => item.source_business_sequence), [1, 2]);
    } finally { await context.pool.end(); }
  });
});

test("预检后权威组织快照变化时确认必须要求重新预检", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "organization-before.xlsx",
        sourceBytes: Buffer.from("organization-before"),
        rows: [row()],
      });
      await context.pool.query("update people set display_name='组长新名称' where id=$1", [context.leaderPersonId]);
      await assert.rejects(
        confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, []),
        /组织关系已变化.*重新预检/,
      );
      const count = await context.pool.query<{ count: number }>("select count(*)::int count from performance_events");
      assert.equal(count.rows[0]!.count, 0);
    } finally {
      await context.pool.end();
    }
  });
});

test("确认锁内重新比较已有订单的首次金额", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "amount-a.xlsx", sourceBytes: Buffer.from("amount-a"), rows: [row()],
      });
      const second = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId: context.configId,
        sourceFileName: "amount-b.xlsx", sourceBytes: Buffer.from("amount-b"),
        rows: [row({ sourceRecordId: "SRC-B", amount: 200 })],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      await assert.rejects(confirmImportBatch(context.pool, second.batchId, context.actorUserId, []), /订单基础事实冲突/);
      const totals = await context.pool.query<{ events: number; total: string }>("select count(*)::int events,sum(delta_amount)::text total from performance_events");
      assert.deepEqual(totals.rows[0], { events: 1, total: "100.00" });
    } finally {
      await context.pool.end();
    }
  });
});

test("历史负流水事件保留真实累计计入额而不截断为零", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const configId = await legacyConfig(context.pool);
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId,
        sourceFileName: "legacy-negative.xlsx",
        sourceBytes: Buffer.from("legacy-negative"),
        rows: [
          row({ sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment", amount: 100 }),
          row({ sheet: "分子", rowNumber: 3, sourceRecordId: undefined, eventType: "legacy_adjustment", amount: -150 }),
        ],
      });
      assert.ok(preflight.issues.some((issue) => issue.code === "HISTORICAL_REVIEW_REQUIRED" && issue.severity === "warning"));
      await confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, ["2:HISTORICAL_REVIEW_REQUIRED"]);
      const events = await context.pool.query<{ current: string; counted: string }>(
        `select resulting_current_revenue::text current,resulting_counted_amount::text counted
         from performance_events order by order_sequence`,
      );
      assert.deepEqual(events.rows, [
        { current: "100.00", counted: "100.00" },
        { current: "0.00", counted: "-50.00" },
      ]);
    } finally {
      await context.pool.end();
    }
  });
});

test("已有历史订单追加相抵流水后按完整事件数进入待核状态", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const configId = await legacyConfig(context.pool);
      const legacyRow = (amount: number, reason: string): ImportSourceRow => row({
        sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment", amount, reason,
      });
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId, sourceFileName: "legacy-positive.xlsx",
        sourceBytes: Buffer.from("legacy-positive"), rows: [legacyRow(100, "正向")],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, []);
      const second = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId, sourceFileName: "legacy-offset.xlsx",
        sourceBytes: Buffer.from("legacy-offset"), rows: [legacyRow(-100, "相抵")],
      });
      assert.ok(second.issues.some((issue) => issue.code === "HISTORICAL_REVIEW_REQUIRED"));
      await confirmImportBatch(context.pool, second.batchId, context.actorUserId, ["2:HISTORICAL_REVIEW_REQUIRED"]);
      const orderState = await context.pool.query<{ lifecycle_state: string; counted_amount: string }>(
        "select lifecycle_state,counted_amount::text from performance_orders where qingflow_order_no='001-A'",
      );
      assert.deepEqual(orderState.rows[0], { lifecycle_state: "historical_review_required", counted_amount: "0.00" });
    } finally {
      await context.pool.end();
    }
  });
});

test("历史待核订单不能通过后续正流水绕过核对审批", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const configId = await legacyConfig(context.pool);
      const legacyRow = (amount: number, reason: string): ImportSourceRow => row({
        sheet: "分子", sourceRecordId: undefined, eventType: "legacy_adjustment", amount, reason,
      });
      const first = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId, sourceFileName: "legacy-review.xlsx",
        sourceBytes: Buffer.from("legacy-review"), rows: [legacyRow(-50, "待核")],
      });
      await confirmImportBatch(context.pool, first.batchId, context.actorUserId, ["2:HISTORICAL_REVIEW_REQUIRED"]);
      const second = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId, configId, sourceFileName: "legacy-positive-later.xlsx",
        sourceBytes: Buffer.from("legacy-positive-later"), rows: [legacyRow(100, "后续正流水")],
      });
      await confirmImportBatch(context.pool, second.batchId, context.actorUserId, ["2:HISTORICAL_REVIEW_REQUIRED"]);
      const state = await context.pool.query<{ lifecycle_state: string }>(
        "select lifecycle_state from performance_orders where qingflow_order_no='001-A'",
      );
      assert.equal(state.rows[0]!.lifecycle_state, "historical_review_required");
    } finally {
      await context.pool.end();
    }
  });
});

test("确认期间发生数据库冲突时整批回滚", async () => {
  await withMigratedTestDatabase(async (database) => {
    const context = await fixture(database.url);
    try {
      const preflight = await preflightImportRows(context.pool, {
        actorUserId: context.actorUserId,
        configId: context.configId,
        sourceFileName: "race.xlsx",
        sourceBytes: Buffer.from("synthetic-race"),
        rows: [row(), row({ rowNumber: 3, sourceRecordId: "SRC-002", orderNo: "002-A", amount: 50 })],
      });
      await context.pool.query(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state)
         values('002-A','冲突客户','冲突单位','业务员甲','2026-03-05',1,1,1,'active')`,
      );
      await assert.rejects(confirmImportBatch(context.pool, preflight.batchId, context.actorUserId, []), /订单基础事实冲突/);
      const counts = await context.pool.query("select (select count(*) from performance_orders where qingflow_order_no='001-A')::int first,(select count(*) from performance_events)::int events");
      assert.deepEqual(counts.rows[0], { first: 0, events: 0 });
    } finally {
      await context.pool.end();
    }
  });
});
