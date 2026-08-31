import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { withTestDatabase, type TestDatabase } from "./test-support/test-database.js";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsRoot = fileURLToPath(new URL("../migrations/", import.meta.url));

type DatabaseRoles = Readonly<{
  migration: string;
  app: string;
  backup: string;
  migrationPassword: string;
  appPassword: string;
  backupPassword: string;
}>;

function rolesFor(database: TestDatabase): DatabaseRoles {
  const suffix = database.name.slice("sampleflow_test_".length);
  return {
    migration: `sf_migration_${suffix}`,
    app: `sf_app_${suffix}`,
    backup: `sf_backup_${suffix}`,
    migrationPassword: "isolated-migration-'test\\2026",
    appPassword: "isolated-app-'test\\password-2026",
    backupPassword: "isolated-backup-'test\\2026",
  };
}

function roleUrl(database: TestDatabase, role: string, password: string): string {
  const url = new URL(database.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function provision(database: TestDatabase, roles: DatabaseRoles): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/provision-database-roles.ts"], {
    cwd: apiRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_ADMIN_URL: database.url,
      DB_MIGRATION_USER: roles.migration,
      DB_MIGRATION_PASSWORD: roles.migrationPassword,
      DB_APP_USER: roles.app,
      DB_APP_PASSWORD: roles.appPassword,
      DB_BACKUP_USER: roles.backup,
      DB_BACKUP_PASSWORD: roles.backupPassword,
    },
  });
}

async function migrate(url: string): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
    cwd: apiRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url },
  });
}

async function dropRoles(adminUrl: string, roles: DatabaseRoles, extraRoles: string[] = []): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`drop role if exists ${extraRoles.join(",")}${extraRoles.length ? "," : ""}${roles.app},${roles.backup},${roles.migration}`);
  } finally {
    await admin.end();
  }
}

async function verifyLeastPrivilege(database: TestDatabase, roles: DatabaseRoles): Promise<void> {
  const app = new Client({ connectionString: roleUrl(database, roles.app, roles.appPassword) });
  const backup = new Client({ connectionString: roleUrl(database, roles.backup, roles.backupPassword) });
  await app.connect();
  await backup.connect();
  try {
    assert.equal((await app.query<{ user: string }>("select current_user user")).rows[0]?.user, roles.app);
    assert.equal((await backup.query<{ user: string }>("select current_user user")).rows[0]?.user, roles.backup);
    assert.equal(
      (await backup.query<{ owner: string }>("select pg_get_userbyid(datdba) owner from pg_database where datname=current_database()")).rows[0]?.owner,
      decodeURIComponent(new URL(database.adminUrl).username),
    );
    await app.query("insert into app_metadata(key,value) values('role-test','ok')");
    await app.query("update app_metadata set value='updated' where key='role-test'");
    assert.equal((await backup.query<{ value: string }>("select value from app_metadata where key='role-test'")).rows[0]?.value, "updated");
    await assert.rejects(app.query("create table forbidden_ddl(id integer)"), /permission denied/);
    await assert.rejects(app.query("create role forbidden_role"), /permission denied/);
    await assert.rejects(app.query("update schema_migrations set name='tampered'"), /permission denied/);
    await assert.rejects(app.query("select setval('users_id_seq',1,false)"), /permission denied/);
    const functionPrivilege = await app.query<{ allowed: boolean; acl: string | null; owner: string }>(
      `select has_function_privilege(current_user,p.oid,'EXECUTE') allowed,p.proacl::text acl,owner.rolname owner
       from pg_proc p join pg_roles owner on owner.oid=p.proowner
       where p.proname='reject_performance_event_mutation'`,
    );
    assert.equal(functionPrivilege.rows[0]?.allowed, false, JSON.stringify(functionPrivilege.rows[0]));
    await assert.rejects(backup.query("insert into app_metadata(key,value) values('forbidden','write')"), /permission denied/);
    assert.equal((await app.query("delete from app_metadata where key='role-test'")).rowCount, 1);
  } finally {
    await app.end();
    await backup.end();
  }
}

test("重复密码或既有角色继承时配置安全失败", async () => {
  let cleanup: { adminUrl: string; roles: DatabaseRoles; operatorRole: string } | undefined;
  try {
    await withTestDatabase(async (database) => {
      const roles = rolesFor(database);
      const operatorRole = `sf_operator_${database.name.slice("sampleflow_test_".length)}`;
      cleanup = { adminUrl: database.adminUrl, roles, operatorRole };
      await assert.rejects(provision(database, { ...roles, backupPassword: roles.appPassword }), /密码必须不同/);
      const admin = new Client({ connectionString: database.url });
      await admin.connect();
      try {
        await admin.query(`create role ${roles.migration}`);
        await admin.query(`create role ${roles.app}`);
        await admin.query(`create role ${operatorRole}`);
        await admin.query(`grant ${roles.migration} to ${roles.app}`);
        await admin.query(`grant ${roles.migration} to ${operatorRole}`);
      } finally {
        await admin.end();
      }
      await assert.rejects(provision(database, roles), /存在角色继承/);
    });
  } finally {
    if (cleanup) await dropRoles(cleanup.adminUrl, cleanup.roles, [cleanup.operatorRole]);
  }
});

test("空库由迁移账号安装且应用和备份账号保持最小权限", async () => {
  let cleanup: { adminUrl: string; roles: DatabaseRoles } | undefined;
  try {
    await withTestDatabase(async (database) => {
      const roles = rolesFor(database);
      cleanup = { adminUrl: database.adminUrl, roles };
      await provision(database, roles);
      await provision(database, roles);
      await migrate(roleUrl(database, roles.migration, roles.migrationPassword));
      await verifyLeastPrivilege(database, roles);
    });
  } finally {
    if (cleanup) await dropRoles(cleanup.adminUrl, cleanup.roles);
  }
});

test("既有库可移交给迁移账号完成升级并保留应用数据", async () => {
  let cleanup: { adminUrl: string; roles: DatabaseRoles } | undefined;
  try {
    await withTestDatabase(async (database) => {
      const legacy = new Client({ connectionString: database.url });
      await legacy.connect();
      try {
        await legacy.query("create table schema_migrations(name text primary key,applied_at timestamptz not null default now())");
        const oldMigrations = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql") && name < "018_").sort();
        for (const name of oldMigrations) {
          await legacy.query(await readFile(`${migrationsRoot}${name}`, "utf8"));
          await legacy.query("insert into schema_migrations(name) values($1)", [name]);
        }
        await legacy.query("insert into app_metadata(key,value) values('upgrade-proof','preserved')");
      } finally {
        await legacy.end();
      }

      const roles = rolesFor(database);
      cleanup = { adminUrl: database.adminUrl, roles };
      await provision(database, roles);
      await migrate(roleUrl(database, roles.migration, roles.migrationPassword));

      const backup = new Client({ connectionString: roleUrl(database, roles.backup, roles.backupPassword) });
      await backup.connect();
      try {
        assert.equal((await backup.query<{ value: string }>("select value from app_metadata where key='upgrade-proof'")).rows[0]?.value, "preserved");
        assert.equal((await backup.query("select 1 from schema_migrations where name='018_add_import_reconciliation.sql'")).rowCount, 1);
      } finally {
        await backup.end();
      }
      await verifyLeastPrivilege(database, roles);
    });
  } finally {
    if (cleanup) await dropRoles(cleanup.adminUrl, cleanup.roles);
  }
});
