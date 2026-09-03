import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import {
  assertTestDatabaseUrl,
  withMigratedTestDatabase,
  withTestDatabase,
} from "./test-support/test-database.js";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsRoot = fileURLToPath(new URL("../migrations/", import.meta.url));

test("隔离数据库在测试失败后仍会被删除", async () => {
  let databaseName = "";
  let adminUrl = "";

  await assert.rejects(
    withTestDatabase(async (database) => {
      databaseName = database.name;
      adminUrl = database.adminUrl;
      assert.match(databaseName, /^sampleflow_test_[a-f0-9]+$/);

      const client = new Client({ connectionString: database.url });
      await client.connect();
      try {
        const result = await client.query<{ name: string }>("select current_database() as name");
        assert.equal(result.rows[0]?.name, databaseName);
      } finally {
        await client.end();
      }

      throw new Error("故意触发测试失败");
    }),
    /故意触发测试失败/,
  );

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const result = await admin.query("select 1 from pg_database where datname = $1", [databaseName]);
    assert.equal(result.rowCount, 0);
  } finally {
    await admin.end();
  }
});

test("干净隔离数据库可应用全部现有迁移", async () => {
  await withMigratedTestDatabase(async (database) => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      const result = await client.query<{ name: string; sha256: string }>("select name,sha256 from schema_migrations order by name");
      assert.deepEqual(result.rows.map((row) => row.name), [
        "001_bootstrap.sql",
        "002_identity_and_organization.sql",
        "003_performance_ledger.sql",
        "004_target_workflow.sql",
        "005_legacy_import_tracking.sql",
        "006_bootstrap_organization_from_ledger.sql",
        "007_temporary_password_expiry.sql",
        "008_session_csrf.sql",
        "009_authentication_state.sql",
        "010_stable_people_and_organization.sql",
        "011_organization_import_tracking.sql",
        "012_organization_coverage_constraints.sql",
        "013_require_owner_for_active_org_units.sql",
        "014_govern_performance_event_order.sql",
        "015_accounting_period_governance.sql",
        "016_goal_governance.sql",
        "017_controlled_performance_import.sql",
        "018_add_import_reconciliation.sql",
        "019_performance_order_cursor.sql",
        "020_event_analysis_dimensions.sql",
        "021_controlled_dimension_backfill.sql",
        "022_freeze_analysis_dimension_pagination.sql",
        "023_immutable_confirmations_and_audit.sql",
        "024_auth_throttle_cleanup.sql",
        "025_enforce_performance_order_state_amounts.sql",
        "026_sheet3_order_input.sql",
        "027_repair_legacy_import_dates.sql",
        "028_allow_receivable_historical_reviews.sql",
      ]);
      assert.ok(result.rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)));
      await assert.rejects(
        client.query(
          `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state)
           values('INVALID-ACTIVE-STATE','约束客户','约束单位','约束业务员',current_date,1,0,0,'active')`,
        ),
        /performance_orders_state_amounts_check/,
      );
    } finally {
      await client.end();
    }
  });
});

test("旧迁移账本可审计补齐 SHA-256 且重复执行不改业务数据", async () => {
  await withTestDatabase(async (database) => {
    const migrationsDirectory = await mkdtemp(path.join(tmpdir(), "sampleflow-migrations-"));
    const migrationName = "001_bootstrap.sql";
    const sql = await readFile(`${migrationsRoot}${migrationName}`, "utf8");
    await writeFile(path.join(migrationsDirectory, migrationName), sql, "utf8");
    const expectedHash = createHash("sha256").update(sql).digest("hex");
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values($1)", [migrationName]);
      await client.query("insert into app_metadata(key,value) values('legacy-proof','unchanged')");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
          cwd: apiRoot,
          env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test", TEST_MIGRATIONS_DIR: migrationsDirectory },
          encoding: "utf8",
        });
      }

      const ledger = await client.query<{ sha256: string; sha256_recorded_at: Date | null }>(
        "select sha256,sha256_recorded_at from schema_migrations where name=$1",
        [migrationName],
      );
      assert.equal(ledger.rows[0]!.sha256, expectedHash);
      assert.ok(ledger.rows[0]!.sha256_recorded_at);
      assert.equal((await client.query<{ value: string }>("select value from app_metadata where key='legacy-proof'")).rows[0]!.value, "unchanged");
      assert.equal((await client.query("select 1 from schema_migrations")).rowCount, 1);

      await writeFile(path.join(migrationsDirectory, migrationName), `${sql}\n-- 内容变化`, "utf8");
      await assert.rejects(
        execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
          cwd: apiRoot,
          env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test", TEST_MIGRATIONS_DIR: migrationsDirectory },
          encoding: "utf8",
        }),
        (error: unknown) => {
          assert.match(String((error as { stderr?: string }).stderr), /已应用迁移内容校验失败/);
          return true;
        },
      );
      assert.equal((await client.query<{ value: string }>("select value from app_metadata where key='legacy-proof'")).rows[0]!.value, "unchanged");
    } finally {
      await client.end();
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });
});

test("既有分析维度升级后获得连续冻结序列", async () => {
  await withTestDatabase(async (database) => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    let eventId = "";
    try {
      await client.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
      const previousMigrations = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql") && name < "022_").sort();
      for (const name of previousMigrations) {
        await client.query(await readFile(`${migrationsRoot}${name}`, "utf8"));
        await client.query("insert into schema_migrations(name) values($1)", [name]);
      }
      const user = await client.query<{ id: string }>(
        "insert into users(username,display_name,password_hash,password_salt,must_change_password) values('dimension_sequence_upgrade','维度序列升级','hash','salt',false) returning id::text",
      );
      const person = await client.query<{ id: string }>("select id::text from people where user_id=$1", [user.rows[0]!.id]);
      const order = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
           salesperson_person_id,salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,created_by,posted_at)
         values('DIMENSION-SEQUENCE-UPGRADE','维度序列客户','维度序列单位','江苏来源','CN-JS',$1,'维度序列升级','2026-08-01',1,1,1,'active',$2,now()) returning id::text`,
        [person.rows[0]!.id, user.rows[0]!.id],
      );
      await client.query("begin");
      const event = await client.query<{ id: string }>(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,occurred_on,reason,
           salesperson_person_id,salesperson_name,department_name,group_name,created_by)
         values($1,'initial',1,1,1,'2026-08-01','2026-08-01','维度序列升级',$2,'维度序列升级','维度序列部门','维度序列小组',$3) returning id::text`,
        [order.rows[0]!.id, person.rows[0]!.id, user.rows[0]!.id],
      );
      eventId = event.rows[0]!.id;
      await client.query(
        "insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit) values($1,'CN-JS','江苏来源','维度序列单位')",
        [eventId],
      );
      await client.query("commit");
    } finally {
      await client.end();
    }

    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const existing = await verify.query<{ dimension_sequence: string }>(
        "select dimension_sequence::text from performance_event_analysis_dimensions where event_id=$1",
        [eventId],
      );
      assert.match(existing.rows[0]!.dimension_sequence, /^[1-9]\d*$/);
      const next = await verify.query<{ dimension_sequence: string }>(
        "select nextval(pg_get_serial_sequence('performance_event_analysis_dimensions','dimension_sequence'))::text as dimension_sequence",
      );
      assert.ok(BigInt(next.rows[0]!.dimension_sequence) > BigInt(existing.rows[0]!.dimension_sequence));
    } finally {
      await verify.end();
    }
  });
});

test("事件分析维度迁移故障不留下 schema 记录、对象或数据半成品", async () => {
  await withTestDatabase(async (database) => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    const injectedMigrations = await mkdtemp(path.join(tmpdir(), "sampleflow-migrations-"));
    try {
      await client.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
      const previousMigrations = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql") && name < "020_").sort();
      for (const name of previousMigrations) {
        const sql = await readFile(`${migrationsRoot}${name}`, "utf8");
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values($1)", [name]);
        await writeFile(path.join(injectedMigrations, name), sql, "utf8");
      }
      await client.query(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,business_region_source_text,business_region_code,
           salesperson_name,source_received_on,original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         values('MIGRATION-FAILURE','迁移故障客户','原始单位','江苏原文','CN-JS','迁移业务员','2026-08-01',1,1,1,'active',now())`,
      );
      await writeFile(
        path.join(injectedMigrations, "020_failure_injection.sql"),
        `alter table performance_events add column failure_probe text;
         create table migration_failure_partial(id integer primary key);
         update performance_orders set customer_unit='半成品' where qingflow_order_no='MIGRATION-FAILURE';
         do $$ begin raise exception '迁移故障注入'; end $$;`,
        "utf8",
      );

      let failed = false;
      try {
        await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
          cwd: apiRoot,
          env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test", TEST_MIGRATIONS_DIR: injectedMigrations },
          encoding: "utf8",
        });
      } catch (error) {
        failed = true;
        assert.match(String((error as { stderr?: string }).stderr), /迁移故障注入/);
      }
      assert.equal(failed, true);
      assert.equal((await client.query("select 1 from schema_migrations where name='020_failure_injection.sql'")).rowCount, 0);
      assert.equal((await client.query("select 1 from information_schema.columns where table_name='performance_events' and column_name='failure_probe'")).rowCount, 0);
      assert.equal((await client.query<{ name: string | null }>("select to_regclass('migration_failure_partial')::text name")).rows[0]!.name, null);
      assert.equal((await client.query<{ customer_unit: string }>("select customer_unit from performance_orders where qingflow_order_no='MIGRATION-FAILURE'")).rows[0]!.customer_unit, "原始单位");
    } finally {
      await client.end();
      await rm(injectedMigrations, { recursive: true, force: true });
    }
  });
});

test("已有导入批次升级到逐月对账结构时保留旧证据标记", async () => {
  await withTestDatabase(async (database) => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
      const existingMigrations = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql") && name < "018_").sort();
      for (const name of existingMigrations) {
        await client.query(await readFile(`${migrationsRoot}${name}`, "utf8"));
        await client.query("insert into schema_migrations(name) values($1)", [name]);
      }
      const user = await client.query<{ id: string }>(
        "insert into users(username,display_name,password_hash,password_salt,must_change_password) values('upgrade_import','升级导入','hash','salt',false) returning id::text",
      );
      const config = await client.query<{ id: string }>("select id::text from import_configs where config_key='standard-performance'");
      await client.query(
        `insert into import_batches(config_id,source_file_name,source_sha256,source_bytes,status,uploaded_by,row_count,order_count,event_count,total_amount)
         values($1,'old.xlsx','old-hash',$2,'blocked',$3,2,2,2,150)`,
        [config.rows[0]!.id, Buffer.from("old"), user.rows[0]!.id],
      );
    } finally {
      await client.end();
    }

    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const result = await verify.query<{ expected: unknown; purpose:string; summary: { legacyBackfill: boolean; actual: { monthly: unknown[] } } }>(
        `select config.expected_reconciliation expected,batch.purpose,batch.reconciliation_summary summary
         from import_batches batch join import_configs config on config.id=batch.config_id`,
      );
      assert.equal(result.rows[0]!.expected, null);
      assert.equal(result.rows[0]!.purpose, "ledger_import");
      assert.equal(result.rows[0]!.summary.legacyBackfill, true);
      assert.deepEqual(result.rows[0]!.summary.actual.monthly, []);
    } finally {
      await verify.end();
    }
  });
});

test("已有不可变业绩事件的数据库可升级并保持事件不可变", async () => {
  await withTestDatabase(async (database) => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    let eventId = "";
    try {
      await client.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
      const existingMigrations = [
        "001_bootstrap.sql", "002_identity_and_organization.sql", "003_performance_ledger.sql",
        "004_target_workflow.sql", "005_legacy_import_tracking.sql", "006_bootstrap_organization_from_ledger.sql",
        "007_temporary_password_expiry.sql", "008_session_csrf.sql", "009_authentication_state.sql",
        "010_stable_people_and_organization.sql", "011_organization_import_tracking.sql",
        "012_organization_coverage_constraints.sql", "013_require_owner_for_active_org_units.sql",
      ];
      for (const name of existingMigrations) {
        await client.query(await readFile(`${migrationsRoot}${name}`, "utf8"));
        await client.query("insert into schema_migrations(name) values($1)", [name]);
      }
      const user = await client.query<{ id: string }>(
        "insert into users(username,display_name,password_hash,password_salt,must_change_password) values('upgrade_ledger','升级账本','hash','salt',false) returning id::text",
      );
      const person = await client.query<{ id: string }>("select id::text from people where user_id=$1", [user.rows[0]!.id]);
      const order = await client.query<{ id: string }>(
        `insert into performance_orders
          (qingflow_order_no,customer_name,customer_unit,salesperson_person_id,salesperson_name,source_received_on,
           original_amount,current_revenue,counted_amount,lifecycle_state,created_by,posted_at)
         values('UPGRADE-LEDGER','升级客户','升级单位',$1,'升级账本','2026-08-01',100,100,100,'active',$2,now()) returning id::text`,
        [person.rows[0]!.id, user.rows[0]!.id],
      );
      const event = await client.query<{ id: string }>(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,
           occurred_on,reason,salesperson_name,department_name,group_name,created_by,salesperson_person_id)
         values($1,'initial',100,100,100,'2026-08-01','2026-08-01','既有事件','升级账本','升级部门','升级小组',$2,$3)
         returning id::text`,
        [order.rows[0]!.id, user.rows[0]!.id, person.rows[0]!.id],
      );
      eventId = event.rows[0]!.id;
    } finally {
      await client.end();
    }

    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const event = await verify.query<{ occurred_at: Date; order_sequence: number }>(
        "select occurred_at,order_sequence from performance_events where id=$1", [eventId],
      );
      assert.ok(event.rows[0]!.occurred_at);
      assert.equal(event.rows[0]!.order_sequence, 1);
      const dimensions = await verify.query("select 1 from performance_event_analysis_dimensions where event_id=$1", [eventId]);
      assert.equal(dimensions.rowCount, 0, "旧事件不能从订单当前投影自动倒推分析维度");
      await assert.rejects(verify.query("update performance_events set reason='篡改' where id=$1", [eventId]), /已入账业绩事件不可更新或删除/);
      await verify.query("begin");
      await verify.query(
        `insert into performance_events
          (order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,accounting_month,
           occurred_on,reason,salesperson_name,department_name,group_name,created_by,salesperson_person_id)
         select order_id,'revenue_change',1,101,101,'2026-08-01','2026-08-02','缺少分析维度',
                salesperson_name,department_name,group_name,null,salesperson_person_id
         from performance_events where id=$1`,
        [eventId],
      );
      await assert.rejects(verify.query("commit"), /新业绩事件必须在同一事务写入分析维度快照/);
      await verify.query("rollback");
    } finally {
      await verify.end();
    }
  });
});

test("旧历史导入事件升级后保持不变并由独立证据表保存复合来源键", async () => {
  await withTestDatabase(async (database) => {
    const sourceHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
      const migrations = [
        "001_bootstrap.sql", "002_identity_and_organization.sql", "003_performance_ledger.sql",
        "004_target_workflow.sql", "005_legacy_import_tracking.sql", "006_bootstrap_organization_from_ledger.sql",
        "007_temporary_password_expiry.sql", "008_session_csrf.sql", "009_authentication_state.sql",
        "010_stable_people_and_organization.sql", "011_organization_import_tracking.sql",
        "012_organization_coverage_constraints.sql", "013_require_owner_for_active_org_units.sql",
        "014_govern_performance_event_order.sql", "015_accounting_period_governance.sql", "016_goal_governance.sql",
      ];
      for (const name of migrations) {
        await client.query(await readFile(`${migrationsRoot}${name}`, "utf8"));
        await client.query("insert into schema_migrations(name) values($1)", [name]);
        if (name === "005_legacy_import_tracking.sql") {
          const order = await client.query<{ id: string }>(
            `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,source_received_on,
               original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
             values('LEGACY-001','旧客户','旧单位','旧业务员','2026-01-02',100,100,100,'active',now()) returning id::text`,
          );
          await client.query(
            `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
               accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number)
             values($1,'legacy_adjustment',100,100,100,'2026-01-01','2026-01-02','旧导入','旧业务员','旧部门','旧小组',2)`,
            [order.rows[0]!.id],
          );
          await client.query(
            "insert into legacy_import_runs(source_file,source_sha256,source_rows,imported_orders,imported_events) values('原始数据1.xlsx',$1,1,1,1)",
            [sourceHash],
          );
        }
      }
    } finally {
      await client.end();
    }

    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const event = await verify.query<{ source_file_sha256: string | null; source_sheet: string | null; source_key: string | null }>(
        "select source_file_sha256,source_sheet,source_key from performance_events where source_row_number=2",
      );
      assert.deepEqual(event.rows[0], {
        source_file_sha256: null,
        source_sheet: null,
        source_key: null,
      });
      const evidence = await verify.query<{ source_file_sha256: string; source_sheet: string; source_row_number: string; source_key: string }>(
        "select source_file_sha256,source_sheet,source_row_number::text,source_key from legacy_event_source_evidence",
      );
      assert.deepEqual(evidence.rows[0], {
        source_file_sha256: sourceHash,
        source_sheet: "分子",
        source_row_number: "2",
        source_key: `legacy:${sourceHash}:分子:2`,
      });
    } finally {
      await verify.end();
    }
  });
});

test("权威旧历史日期只在完整基线吻合时留下证据并受控修复", async () => {
  await withTestDatabase(async (database) => {
    const sourceHash = "926aad3d8c59cc356094eb1abc0ca1fcb3392eae5867f2b7c0e2bb50bb5c01cf";
    const repairOnlyMigrations = await mkdtemp(path.join(tmpdir(), "sampleflow-date-repair-"));
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
      const previousMigrations = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql") && name < "027_").sort();
      for (const name of previousMigrations) {
        const sql = await readFile(`${migrationsRoot}${name}`, "utf8");
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values($1)", [name]);
        await writeFile(path.join(repairOnlyMigrations, name), sql, "utf8");
      }
      await writeFile(
        path.join(repairOnlyMigrations, "027_repair_legacy_import_dates.sql"),
        await readFile(`${migrationsRoot}027_repair_legacy_import_dates.sql`, "utf8"),
        "utf8",
      );
      await client.query(
        `insert into performance_orders(qingflow_order_no,customer_name,customer_unit,salesperson_name,source_received_on,
           original_amount,current_revenue,counted_amount,lifecycle_state,posted_at)
         select 'LEGACY-DATE-'||n,'旧客户','旧单位','旧业务员','2026-01-03',1,1,1,'active',now()
         from generate_series(1,2850) n`,
      );
      await client.query(
        "insert into legacy_import_runs(source_file,source_sha256,source_rows,imported_orders,imported_events) values('原始数据1.xlsx',$1,4701,2850,4701)",
        [sourceHash],
      );
      await client.query("begin");
      await client.query("set local session_replication_role=replica");
      await client.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number,order_sequence)
         values(1,'legacy_adjustment',14675659.07,14675659.07,14675659.07,'2026-01-01','2026-01-03','历史明细迁移','旧业务员','旧部门','旧小组',2,1)`,
      );
      await client.query(
        "insert into legacy_event_source_evidence(event_id,source_file_sha256,source_sheet,source_row_number,source_key) select id,$1,'分子',2,'legacy:'||$1||':分子:2' from performance_events",
        [sourceHash],
      );
      await client.query("commit");
      await assert.rejects(
        execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
          cwd: apiRoot,
          env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test", TEST_MIGRATIONS_DIR: repairOnlyMigrations },
          encoding: "utf8",
        }),
        /旧历史日期修复基线不一致/,
      );
      await client.query("begin");
      await client.query("set local session_replication_role=replica");
      await client.query(
        `insert into performance_events(order_id,event_type,delta_amount,resulting_current_revenue,resulting_counted_amount,
           accounting_month,occurred_on,reason,salesperson_name,department_name,group_name,source_row_number,order_sequence)
         select case when n<=2850 then n else n-2850 end,'legacy_adjustment',0,1,1,
                date_trunc('month',case when n=4701 then date '2026-08-25' else date '2026-01-04' end)::date,
                case when n=4701 then date '2026-08-25' else date '2026-01-04' end,
                case when n<=2711 then '历史明细迁移' else '原始备注' end,
                '旧业务员','旧部门','旧小组',n+1,case when n<=2850 then 1 else 2 end
         from generate_series(2,4701) n`,
      );
      await client.query(
        `insert into legacy_event_source_evidence(event_id,source_file_sha256,source_sheet,source_row_number,source_key)
         select id,$1,'分子',source_row_number,'legacy:'||$1||':分子:'||source_row_number
         from performance_events where id>1`,
        [sourceHash],
      );
      await client.query("commit");
      await assert.rejects(
        execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
          cwd: apiRoot,
          env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test", TEST_MIGRATIONS_DIR: repairOnlyMigrations },
          encoding: "utf8",
        }),
        /旧历史日期修复逐月基线不一致/,
      );
      await client.query("begin");
      await client.query("set local session_replication_role=replica");
      await client.query(
        `with numbered as (
           select id,row_number() over(order by source_row_number)::int n from performance_events
         ), corrected as (
           select id,n,
             case when n=1 then date '2026-01-03'
                  when n<=635 then date '2026-01-14'
                  when n<=1090 then date '2026-02-14'
                  when n<=1650 then date '2026-03-14'
                  when n<=2170 then date '2026-04-14'
                  when n<=2644 then date '2026-05-14'
                  when n<=3275 then date '2026-06-14'
                  when n<=4053 then date '2026-07-14'
                  when n=4701 then date '2026-08-25'
                  else date '2026-08-14' end occurred_on,
             case n when 1 then 2314819.55 when 636 then 1252546.10 when 1091 then 1346159.95
                  when 1651 then 1989517.64 when 2171 then 1499121.10 when 2645 then 2234990.59
                  when 3276 then 2487624.14 when 4054 then 1550880.00 else 0 end amount
           from numbered
         )
         update performance_events event set occurred_on=corrected.occurred_on,
           accounting_month=date_trunc('month',corrected.occurred_on)::date,
           delta_amount=corrected.amount,resulting_current_revenue=corrected.amount,resulting_counted_amount=corrected.amount,
           reason=case when corrected.n<=2711 then '历史明细迁移' else '原始备注' end
         from corrected where corrected.id=event.id`,
      );
      const actor = await client.query<{id:string}>(
        "insert into users(username,display_name,password_hash,password_salt) values('date-repair-reviewer','日期修复审核人','hash','salt') returning id::text",
      );
      const batch = await client.query<{id:string}>(
        `insert into import_batches(config_id,source_file_name,source_sha256,source_bytes,status,uploaded_by,confirmed_by,
           row_count,order_count,event_count,total_amount,purpose,confirmed_at,reconciliation_summary)
         select min(id),'原始数据1.xlsx',$1,''::bytea,'imported',$2,$2,4701,2850,4701,14675659.07,'dimension_backfill',now(),'{}'::jsonb
         from import_configs returning id::text`,
        [sourceHash,actor.rows[0]!.id],
      );
      await client.query(
        `insert into import_batch_rows(batch_id,source_sheet,source_row_number,source_key,duplicate_fingerprint,normalized_data)
         select $1,evidence.source_sheet,evidence.source_row_number,evidence.source_key,evidence.source_key,
                jsonb_build_object('occurredOn',(event.occurred_on+1)::text,'reason',
                  case when event.reason='历史明细迁移' then '' else event.reason end)
         from legacy_event_source_evidence evidence join performance_events event on event.id=evidence.event_id
         where evidence.source_file_sha256=$2`,
        [batch.rows[0]!.id,sourceHash],
      );
      await client.query(
        `insert into performance_event_analysis_dimensions(event_id,business_region_code,business_region_source_text,customer_unit)
         select event_id,'CN-JS','江苏省','旧单位' from legacy_event_source_evidence where source_file_sha256=$1`,
        [sourceHash],
      );
      await client.query(
        `insert into legacy_event_analysis_dimension_backfills(event_id,batch_id,batch_row_id,source_file_sha256,confirmed_by,result)
         select evidence.event_id,$1,row.id,$2,$3,'applied'
         from legacy_event_source_evidence evidence join import_batch_rows row
           on row.batch_id=$1 and row.source_sheet=evidence.source_sheet and row.source_row_number=evidence.source_row_number
         where evidence.source_file_sha256=$2`,
        [batch.rows[0]!.id,sourceHash,actor.rows[0]!.id],
      );
      await client.query("commit");
    } finally {
      await client.end();
      await rm(repairOnlyMigrations, { recursive: true, force: true });
    }

    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const result = await verify.query<{
        events: number; eventEvidence: number; orderEvidence: number; firstDate: string; lastDate: string;
        wrongAccountingMonths: number; blankReasons: number; firstOrderDate: string;
      }>(
        `select (select count(*)::int from performance_events) events,
                (select count(*)::int from legacy_event_date_repair_evidence) "eventEvidence",
                (select count(*)::int from legacy_order_date_repair_evidence) "orderEvidence",
                (select min(occurred_on)::text from performance_events) "firstDate",
                (select max(occurred_on)::text from performance_events) "lastDate",
                (select count(*)::int from performance_events where accounting_month<>date_trunc('month',occurred_on)::date) "wrongAccountingMonths",
                (select count(*)::int from performance_events where reason='') "blankReasons",
                (select min(source_received_on)::text from performance_orders) "firstOrderDate"`,
      );
      assert.deepEqual(result.rows[0], {
        events:4701, eventEvidence:4701, orderEvidence:2850, firstDate:"2026-01-04", lastDate:"2026-08-26",
        wrongAccountingMonths:0, blankReasons:2711, firstOrderDate:"2026-01-04",
      });
      await assert.rejects(verify.query("update performance_events set reason='篡改' where id=1"), /已入账业绩事件不可更新或删除/);
      await assert.rejects(verify.query("delete from legacy_event_date_repair_evidence where event_id=1"), /导入批次行证据不可更新或删除/);
    } finally {
      await verify.end();
    }
  });
});

test("既有启用组织在负责人治理前可升级并安全转为停用",async()=>{
  await withTestDatabase(async(database)=>{
    const client=new Client({connectionString:database.url});
    await client.connect();
    try{
      for(const name of [
        "001_bootstrap.sql","002_identity_and_organization.sql","003_performance_ledger.sql","004_target_workflow.sql",
        "005_legacy_import_tracking.sql","006_bootstrap_organization_from_ledger.sql","007_temporary_password_expiry.sql",
        "008_session_csrf.sql","009_authentication_state.sql","010_stable_people_and_organization.sql",
        "011_organization_import_tracking.sql","012_organization_coverage_constraints.sql",
      ])await client.query(await readFile(`${migrationsRoot}${name}`,"utf8"));
      const department=await client.query<{id:string}>("insert into org_units(name,unit_type) values('待治理旧部门','department') returning id::text");
      await client.query("insert into org_units(name,unit_type,parent_id) values('待治理旧小组','group',$1)",[department.rows[0]!.id]);

      await client.query(await readFile(`${migrationsRoot}013_require_owner_for_active_org_units.sql`,"utf8"));
      const result=await client.query<{active:string}>("select count(*) filter(where is_active)::text as active from org_units");
      assert.equal(result.rows[0]!.active,"0");
    }finally{await client.end();}
  });
});

test("既有首次改密账号升级后获得到期时间且旧会话被撤销", async () => {
  await withTestDatabase(async (database) => {
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query(`create table schema_migrations(name text primary key,applied_at timestamptz not null default now())`);
      const legacyMigrations = [
        "001_bootstrap.sql",
        "002_identity_and_organization.sql",
        "003_performance_ledger.sql",
        "004_target_workflow.sql",
        "005_legacy_import_tracking.sql",
        "006_bootstrap_organization_from_ledger.sql",
      ];
      for (const name of legacyMigrations) {
        await client.query(await readFile(`${migrationsRoot}${name}`, "utf8"));
        await client.query("insert into schema_migrations(name) values($1)", [name]);
      }
      const user = await client.query<{ id: string }>(
        `insert into users(username,display_name,password_hash,password_salt,must_change_password)
         values('legacy_temp_user','遗留临时密码用户','hash','salt',true) returning id::text`,
      );
      await client.query(
        `insert into sessions(user_id,token_hash,expires_at) values($1,'legacy-session',now()+interval '8 hours')`,
        [user.rows[0]!.id],
      );
    } finally {
      await client.end();
    }

    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      encoding: "utf8",
    });

    const verify = new Client({ connectionString: database.url });
    await verify.connect();
    try {
      const user = await verify.query<{ temporary_password_expires_at: Date | null }>(
        "select temporary_password_expires_at from users where username='legacy_temp_user'",
      );
      assert.ok(user.rows[0]!.temporary_password_expires_at);
      const session = await verify.query<{ revoked_at: Date | null }>(
        "select revoked_at from sessions where token_hash='legacy-session'",
      );
      assert.ok(session.rows[0]!.revoked_at);
    } finally {
      await verify.end();
    }
  });
});

test("拒绝在远程 PostgreSQL 主机创建测试数据库", async () => {
  const previousAdminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  process.env.TEST_DATABASE_ADMIN_URL = "postgres://sampleflow:test@database.invalid:5432/postgres";

  try {
    await assert.rejects(withTestDatabase(async () => undefined), /测试数据库仅允许使用本机 PostgreSQL/);
  } finally {
    if (previousAdminUrl === undefined) delete process.env.TEST_DATABASE_ADMIN_URL;
    else process.env.TEST_DATABASE_ADMIN_URL = previousAdminUrl;
  }
});

test("测试 API 与 fixture 只接受专用测试数据库名称", () => {
  assert.throws(
    () => assertTestDatabaseUrl("postgres://sampleflow:test@127.0.0.1:55432/sampleflow"),
    /拒绝连接非 SampleFlow 测试数据库/,
  );
  assert.doesNotThrow(() =>
    assertTestDatabaseUrl("postgres://sampleflow:test@127.0.0.1:55432/sampleflow_test_a1b2")
  );
});
