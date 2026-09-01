import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { seedTestUser } from "./test-support/fixtures.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const operationDirectory = fileURLToPath(new URL("../../../scripts/", import.meta.url));

type DatabaseRoles = Readonly<{
  migration: string;
  app: string;
  backup: string;
  migrationPassword: string;
  appPassword: string;
  backupPassword: string;
}>;

function rolesFor(databaseName: string): DatabaseRoles {
  const suffix = databaseName.slice("sampleflow_test_".length);
  return {
    migration: `sf_migration_${suffix}`,
    app: `sf_app_${suffix}`,
    backup: `sf_backup_${suffix}`,
    migrationPassword: "isolated-migration-'test\\2026",
    appPassword: "isolated-app-'test\\password-2026",
    backupPassword: "isolated-backup-'test\\2026",
  };
}

function roleUrl(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function provision(databaseUrl: string, roles: DatabaseRoles): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/provision-database-roles.ts"], {
    cwd: apiRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_ADMIN_URL: databaseUrl,
      DB_MIGRATION_USER: roles.migration,
      DB_MIGRATION_PASSWORD: roles.migrationPassword,
      DB_APP_USER: roles.app,
      DB_APP_PASSWORD: roles.appPassword,
      DB_BACKUP_USER: roles.backup,
      DB_BACKUP_PASSWORD: roles.backupPassword,
    },
  });
}

async function dropRoles(adminUrl: string, roles: DatabaseRoles): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`drop role if exists ${roles.app},${roles.backup},${roles.migration}`);
  } finally {
    await admin.end();
  }
}

async function runOperation(command: string, variables: Readonly<Record<string, string>>, backupDirectory: string) {
  const environment = Object.entries(variables).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  return execFileAsync("docker", [
    "run", "--rm", "--add-host", "host.docker.internal:host-gateway",
    ...environment,
    "-v", `${operationDirectory}:/operations:ro`,
    "-v", `${backupDirectory}:/backup`,
    "postgres:16", "bash", "/operations/database-operations.sh", command,
  ], { encoding: "utf8", timeout: 60_000 });
}

test("自定义格式备份只恢复到显式新库且保持来源与恢复摘要一致", async () => {
  let roleCleanup: { adminUrl: string; roles: DatabaseRoles } | undefined;
  try {
    await withMigratedTestDatabase(async (source) => {
    await seedTestUser(source.url, {
      username: "restore_smoke",
      displayName: "恢复验收",
      password: "Restore@123",
      roleCode: "sales_assistant",
      roleName: "销售助理",
    });
    const roles = rolesFor(source.name);
    roleCleanup = { adminUrl: source.adminUrl, roles };
    await provision(source.url, roles);

    const sourceUrl = new URL(source.url);
    const adminUrl = new URL(source.adminUrl);
    const targetName = `sampleflow_test_${randomUUID().replaceAll("-", "")}`;
    const corruptTargetName = `sampleflow_test_${randomUUID().replaceAll("-", "")}`;
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = `/${targetName}`;
    const backupDirectory = await mkdtemp(path.join(tmpdir(), "sampleflow-backup-"));
    const sourceVariables = {
      SOURCE_DB_HOST: "host.docker.internal",
      SOURCE_DB_PORT: sourceUrl.port,
      SOURCE_DB_NAME: decodeURIComponent(sourceUrl.pathname.slice(1)),
      SOURCE_DB_USER: roles.backup,
      SOURCE_DB_PASSWORD: roles.backupPassword,
      BACKUP_FILE: "/backup/sampleflow.dump",
    };
    const restoreVariables = {
      ...sourceVariables,
      TARGET_DB_HOST: "host.docker.internal",
      TARGET_DB_PORT: adminUrl.port,
      TARGET_DB_ADMIN_NAME: decodeURIComponent(adminUrl.pathname.slice(1)),
      TARGET_DB_ADMIN_USER: decodeURIComponent(adminUrl.username),
      TARGET_DB_ADMIN_PASSWORD: decodeURIComponent(adminUrl.password),
      TARGET_DB_NAME: targetName,
      TARGET_DB_OWNER: roles.migration,
      TARGET_DB_OWNER_PASSWORD: roles.migrationPassword,
      TARGET_DB_APP_USER: roles.app,
      TARGET_DB_BACKUP_USER: roles.backup,
    };

    try {
      const concurrentBackups = await Promise.allSettled([
        runOperation("backup", sourceVariables, backupDirectory),
        runOperation("backup", sourceVariables, backupDirectory),
      ]);
      assert.equal(
        concurrentBackups.filter((result) => result.status === "fulfilled").length,
        1,
        concurrentBackups.map((result) => result.status === "fulfilled" ? result.value.stdout : result.reason.stderr).join("\n"),
      );
      const rejectedBackup = concurrentBackups.find((result) => result.status === "rejected");
      assert.match(String((rejectedBackup as PromiseRejectedResult).reason.stderr), /已存在或正在由其他进程写入|拒绝覆盖已有文件/);
      const backup = await readFile(path.join(backupDirectory, "sampleflow.dump"));
      assert.equal(backup.subarray(0, 5).toString("ascii"), "PGDMP");
      assert.match(await readFile(path.join(backupDirectory, "sampleflow.dump.sha256"), "utf8"), /^[a-f0-9]{64}  sampleflow\.dump\r?\n$/);
      const backupNames = ["sampleflow.dump", "sampleflow.dump.sha256", "sampleflow.dump.summary", "sampleflow.dump.summary.sha256"];
      const completedBackup = await Promise.all(backupNames.map((name) => readFile(path.join(backupDirectory, name))));
      await assert.rejects(runOperation("backup", sourceVariables, backupDirectory), /拒绝覆盖已有文件/);
      assert.deepEqual(await Promise.all(backupNames.map((name) => readFile(path.join(backupDirectory, name)))), completedBackup);

      await assert.rejects(
        runOperation("restore-new", { ...restoreVariables, TARGET_DB_NAME: "" }, backupDirectory),
        (error: unknown) => {
          assert.match(String((error as { stderr?: string }).stderr), /TARGET_DB_NAME/);
          return true;
        },
      );
      await assert.rejects(
        runOperation("restore-new", { ...restoreVariables, TARGET_DB_NAME: "UnsafeName" }, backupDirectory),
        /最长 63 字节的小写 PostgreSQL 标识符/,
      );
      await assert.rejects(
        runOperation("restore-new", { ...restoreVariables, TARGET_DB_APP_USER: "a".repeat(64) }, backupDirectory),
        /最长 63 字节的小写 PostgreSQL 标识符/,
      );
      await assert.rejects(
        runOperation("restore-new", { ...restoreVariables, TARGET_DB_NAME: sourceVariables.SOURCE_DB_NAME }, backupDirectory),
        (error: unknown) => {
          assert.match(String((error as { stderr?: string }).stderr), /来源库与目标库不能相同/);
          return true;
        },
      );

      await runOperation("restore-new", restoreVariables, backupDirectory);
      const sourceSummary = await runOperation("summary", sourceVariables, backupDirectory);
      assert.equal(sourceSummary.stdout, await readFile(path.join(backupDirectory, "sampleflow.dump.summary"), "utf8"));
      const targetSummary = await runOperation("summary", {
        ...sourceVariables,
        SOURCE_DB_NAME: targetName,
      }, backupDirectory);
      assert.equal(targetSummary.stdout, sourceSummary.stdout);
      assert.match(sourceSummary.stdout, /^schema_migrations\|24\|[a-f0-9]{32}$/m);
      assert.match(sourceSummary.stdout, /^users\|1\|[a-f0-9]{32}$/m);

      const appDatabaseUrl = roleUrl(targetUrl.toString(), roles.app, roles.appPassword);
      const appClient = new Client({ connectionString: appDatabaseUrl });
      const backupClient = new Client({ connectionString: roleUrl(targetUrl.toString(), roles.backup, roles.backupPassword) });
      await appClient.connect();
      await backupClient.connect();
      try {
        await assert.rejects(appClient.query("create table forbidden_restore_ddl(id integer)"), /permission denied/);
        await assert.rejects(backupClient.query("insert into app_metadata(key,value) values('forbidden-restore','write')"), /permission denied/);
      } finally {
        await appClient.end();
        await backupClient.end();
      }

      await withTestApi(appDatabaseUrl, async (app) => {
        const ready = await app.inject({ method: "GET", url: "/api/ready" });
        assert.deepEqual(ready.json(), { status: "ready", database: "connected" });
        const login = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: "http://127.0.0.1:4174" },
          payload: { username: "restore_smoke", password: "Restore@123" },
        });
        assert.equal(login.statusCode, 200, login.body);
      });

      await assert.rejects(
        runOperation("restore-new", restoreVariables, backupDirectory),
        (error: unknown) => {
          assert.match(String((error as { stderr?: string }).stderr), /目标数据库已存在/);
          return true;
        },
      );

      const summaryPath = path.join(backupDirectory, "sampleflow.dump.summary");
      await appendFile(summaryPath, "tampered\n");
      const summaryHash = createHash("sha256").update(await readFile(summaryPath)).digest("hex");
      await writeFile(path.join(backupDirectory, "sampleflow.dump.summary.sha256"), `${summaryHash}  sampleflow.dump.summary\n`, "utf8");
      await assert.rejects(
        runOperation("restore-new", { ...restoreVariables, TARGET_DB_NAME: corruptTargetName }, backupDirectory),
        (error: unknown) => {
          assert.match(String((error as { stderr?: string }).stderr), /稳定摘要与来源不一致/);
          return true;
        },
      );
      const admin = new Client({ connectionString: source.adminUrl });
      await admin.connect();
      try {
        assert.equal((await admin.query("select 1 from pg_database where datname=$1", [corruptTargetName])).rowCount, 0);
        const targetDatabase = await admin.query<{ owner: string; public_connect: boolean }>(
          `select pg_get_userbyid(d.datdba) owner,
                  exists(select 1 from aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) acl
                         where acl.grantee=0 and acl.privilege_type='CONNECT') public_connect
           from pg_database d where d.datname=$1`,
          [targetName],
        );
        assert.deepEqual(targetDatabase.rows[0], { owner: roles.migration, public_connect: false });
      } finally {
        await admin.end();
      }
    } finally {
      const admin = new Client({ connectionString: source.adminUrl });
      await admin.connect();
      try {
        for (const databaseName of [targetName, corruptTargetName]) {
          await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()", [databaseName]);
          await admin.query(`drop database if exists "${databaseName}"`);
        }
      } finally {
        await admin.end();
        await rm(backupDirectory, { recursive: true, force: true });
      }
    }
    });
  } finally {
    if (roleCleanup) await dropRoles(roleCleanup.adminUrl, roleCleanup.roles);
  }
});
