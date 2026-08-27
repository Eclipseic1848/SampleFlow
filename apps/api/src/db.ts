import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool as PgPool } from "pg";
import { config } from "./config.js";

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

export type Database = PgPool;

export async function checkDatabase(database: Database = db): Promise<void> {
  await database.query("select 1");
}

export async function checkDatabaseSchema(database: Database = db): Promise<void> {
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  const expected = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  let applied: string[];
  try {
    const result = await database.query<{ name: string }>("select name from schema_migrations order by name");
    applied = result.rows.map((row) => row.name);
  } catch {
    throw new Error("[启动前置检查] 数据库结构未就绪，请先显式执行 db:migrate 作业");
  }

  const appliedSet = new Set(applied);
  const missing = expected.filter((file) => !appliedSet.has(file));
  if (missing.length > 0) {
    throw new Error(`[启动前置检查] 数据库结构落后，请先显式执行 db:migrate 作业；缺失迁移：${missing.join(", ")}`);
  }
}
