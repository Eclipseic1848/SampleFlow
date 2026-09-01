import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool as PgPool } from "pg";
import { config } from "./config.js";
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
  const expected = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  try {
    await checkDatabase(database);
  } catch {
    throw new DatabaseReadinessError("DB_UNAVAILABLE", "[启动前置检查] 数据库不可用");
  }
  let applied: string[];
  try {
    const result = await database.query<{ name: string }>("select name from schema_migrations order by name");
    applied = result.rows.map((row) => row.name);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "42P01") {
      throw new DatabaseReadinessError("SCHEMA_OUTDATED", "[启动前置检查] 数据库结构未就绪，请先显式执行 db:migrate 作业");
    }
    throw new DatabaseReadinessError("DB_UNAVAILABLE", "[启动前置检查] 数据库不可用");
  }

  const appliedSet = new Set(applied);
  const missing = expected.filter((file) => !appliedSet.has(file));
  if (missing.length > 0) {
    throw new DatabaseReadinessError("SCHEMA_OUTDATED", `[启动前置检查] 数据库结构落后，请先显式执行 db:migrate 作业；缺失迁移：${missing.join(", ")}`);
  }
}
