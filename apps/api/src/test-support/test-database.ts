import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const TEST_DATABASE_PREFIX = "sampleflow_test_";
const LOCAL_ADMIN_URL = "postgres://sampleflow:sampleflow_dev@127.0.0.1:55432/postgres";

export type TestDatabase = Readonly<{
  adminUrl: string;
  name: string;
  url: string;
}>;

function localPostgresUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("测试数据库必须使用 PostgreSQL 连接地址");
  }
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error("测试数据库仅允许使用本机 PostgreSQL");
  }
  return url;
}

function testAdminUrl(): string {
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境禁止创建测试数据库");
  }

  const value = process.env.TEST_DATABASE_ADMIN_URL ?? LOCAL_ADMIN_URL;
  const url = localPostgresUrl(value);
  if (url.pathname !== "/postgres") {
    throw new Error("测试数据库管理连接必须指向 postgres 数据库");
  }

  return url.toString();
}

function databaseIdentifier(name: string): string {
  if (!new RegExp(`^${TEST_DATABASE_PREFIX}[a-f0-9]+$`).test(name)) {
    throw new Error("拒绝连接非 SampleFlow 测试数据库");
  }
  return `"${name}"`;
}

async function waitForDatabaseClientsToDisconnect(admin: InstanceType<typeof Client>, name: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const result = await admin.query<{ count: string }>(
      "select count(*)::text as count from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [name],
    );
    if (result.rows[0]?.count === "0") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function assertTestDatabaseUrl(value: string): void {
  const url = localPostgresUrl(value);
  databaseIdentifier(decodeURIComponent(url.pathname.slice(1)));
}

export async function withTestDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const adminUrl = testAdminUrl();
  const name = `${TEST_DATABASE_PREFIX}${randomUUID().replaceAll("-", "")}`;
  const identifier = databaseIdentifier(name);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${name}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let created = false;

  try {
    await admin.query(`create database ${identifier}`);
    created = true;
    return await run({ adminUrl, name, url: databaseUrl.toString() });
  } finally {
    try {
      if (created) {
        try {
          await waitForDatabaseClientsToDisconnect(admin, name);
          await admin.query(
            "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
            [name],
          );
        } finally {
          await admin.query(`drop database ${identifier}`);
        }
      }
    } finally {
      await admin.end();
    }
  }
}

export async function withMigratedTestDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  return withTestDatabase(async (database) => {
    const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/cli/migrate.ts"], {
      cwd: apiRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: database.url, NODE_ENV: "test" },
      timeout: 30_000,
    });

    if (migration.error) throw migration.error;
    if (migration.status !== 0) {
      throw new Error(`测试数据库迁移失败\n${migration.stdout}\n${migration.stderr}`);
    }

    return run(database);
  });
}
