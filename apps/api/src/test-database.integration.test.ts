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
      ]);
    } finally {
      await client.end();
    }
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
