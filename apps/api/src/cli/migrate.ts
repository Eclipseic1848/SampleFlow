import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env.NODE_ENV === "test" && process.env.TEST_MIGRATIONS_DIR
  ? path.resolve(process.env.TEST_MIGRATIONS_DIR)
  : path.resolve(here, "../../migrations");

const client = await db.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('sampleflow:schema-migrate'))");
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await client.query<{ name: string }>(
      "select name from schema_migrations where name = $1",
      [file],
    );
    if (applied.rowCount) continue;

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`[迁移] 已应用 ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.query("select pg_advisory_unlock(hashtext('sampleflow:schema-migrate'))");
  client.release();
  await db.end();
}
