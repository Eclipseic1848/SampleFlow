import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool as PgPool } from "pg";
import { config } from "./config.js";
import { migrationSha256 } from "./migration-integrity.js";
import { writeProcessLog } from "./observability.js";

const { Pool } = pg;

export const db = new Pool({
  ...(config.databaseUrl ? { connectionString: config.databaseUrl } : {
    host: config.databaseHost,
    port: config.databasePort,
    database: config.databaseName,
    user: config.databaseUser,
    password: config.databasePassword,
  }),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

db.on("error", () => {
  writeProcessLog("database.connection", "DB_CONNECTION_INTERRUPTED", 503);
});

export type Database = PgPool;

export type DatabaseReadinessReason = "DB_UNAVAILABLE" | "SCHEMA_OUTDATED";

export class DatabaseReadinessError extends Error {
  constructor(readonly reasonCode: DatabaseReadinessReason, message: string) {
    super(message);
  }
}

export function databaseReadinessReason(error: unknown): DatabaseReadinessReason {
  return error instanceof DatabaseReadinessError ? error.reasonCode : "DB_UNAVAILABLE";
}

export async function checkDatabase(database: Database = db): Promise<void> {
  await database.query("select 1");
}

export async function checkDatabaseSchema(database: Database = db): Promise<void> {
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  const expected = await Promise.all((await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map(async (name) => ({
      name,
      sha256: migrationSha256(await readFile(path.join(migrationsDir, name))),
    })));
  try {
    await checkDatabase(database);
  } catch {
    throw new DatabaseReadinessError("DB_UNAVAILABLE", "[启动前置检查] 数据库不可用");
  }
  let applied: Array<{ name: string; sha256: string }>;
  try {
    const result = await database.query<{ name: string; sha256: string }>("select name,sha256 from schema_migrations order by name");
    applied = result.rows;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "42P01" || code === "42703") {
      throw new DatabaseReadinessError("SCHEMA_OUTDATED", "[启动前置检查] 数据库结构未就绪，请先显式执行 db:migrate 作业");
    }
    throw new DatabaseReadinessError("DB_UNAVAILABLE", "[启动前置检查] 数据库不可用");
  }

  const expectedByName = new Map(expected.map((migration) => [migration.name, migration.sha256]));
  const appliedByName = new Map(applied.map((migration) => [migration.name, migration.sha256]));
  const missing = expected.filter((migration) => !appliedByName.has(migration.name)).map((migration) => migration.name);
  const unknown = applied.filter((migration) => !expectedByName.has(migration.name)).map((migration) => migration.name);
  if (unknown.length > 0) {
    throw new DatabaseReadinessError("SCHEMA_OUTDATED", `[启动前置检查] 数据库包含当前代码未知迁移：${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new DatabaseReadinessError("SCHEMA_OUTDATED", `[启动前置检查] 数据库结构落后，请先显式执行 db:migrate 作业；缺失迁移：${missing.join(", ")}`);
  }
  const changed = applied.filter((migration) => expectedByName.get(migration.name) !== migration.sha256).map((migration) => migration.name);
  if (changed.length > 0) {
    throw new DatabaseReadinessError("SCHEMA_OUTDATED", `[启动前置检查] 已应用迁移内容校验失败：${changed.join(", ")}`);
  }
}
