import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      const result = await client.query<{ name: string }>("select name from schema_migrations order by name");
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
      ]);
    } finally {
      await client.end();
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
      await assert.rejects(verify.query("update performance_events set reason='篡改' where id=$1", [eventId]), /已入账业绩事件不可更新或删除/);
    } finally {
      await verify.end();
    }
  });
});

test("旧历史导入事件升级后保持不变并由独立证据表保存复合来源键", async () => {
  await withTestDatabase(async (database) => {
    const sourceHash = "926aad3d8c59cc356094eb1abc0ca1fcb3392eae5867f2b7c0e2bb50bb5c01cf";
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
