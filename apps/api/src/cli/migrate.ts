import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db.js";
import { migrationSha256 } from "../migration-integrity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env.NODE_ENV === "test" && process.env.TEST_MIGRATIONS_DIR
  ? path.resolve(process.env.TEST_MIGRATIONS_DIR)
  : path.resolve(here, "../../migrations");
const migrations = await Promise.all((await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map(async (name) => {
    const contents = await readFile(path.join(migrationsDir, name));
    return { name, contents, sha256: migrationSha256(contents) };
  }));

const client = await db.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('sampleflow:schema-migrate'))");
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now(),
      sha256 text not null,
      sha256_recorded_at timestamptz not null default now()
    )
  `);

  const appliedNames = await client.query<{ name: string }>("select name from schema_migrations order by name");
  const expectedNames = new Set(migrations.map((migration) => migration.name));
  const unknown = appliedNames.rows.map((row) => row.name).filter((name) => !expectedNames.has(name));
  if (unknown.length > 0) throw new Error(`[迁移] 数据库包含当前代码未知迁移：${unknown.join(", ")}`);

  await client.query("begin");
  try {
    await client.query("alter table schema_migrations add column if not exists sha256 text");
    await client.query("alter table schema_migrations add column if not exists sha256_recorded_at timestamptz");
    const applied = await client.query<{ name: string; sha256: string | null }>("select name,sha256 from schema_migrations order by name");
    const expectedHashes = new Map(migrations.map((migration) => [migration.name, migration.sha256]));
    for (const migration of applied.rows) {
      const expectedHash = expectedHashes.get(migration.name)!;
      if (migration.sha256 !== null && migration.sha256 !== expectedHash) {
        throw new Error(`[迁移] 已应用迁移内容校验失败：${migration.name}`);
      }
      await client.query(
        "update schema_migrations set sha256=$2,sha256_recorded_at=coalesce(sha256_recorded_at,now()) where name=$1 and sha256 is null",
        [migration.name, expectedHash],
      );
      await client.query("update schema_migrations set sha256_recorded_at=now() where name=$1 and sha256_recorded_at is null", [migration.name]);
    }
    await client.query("alter table schema_migrations alter column sha256 set not null");
    await client.query("alter table schema_migrations alter column sha256_recorded_at set default now()");
    await client.query("alter table schema_migrations alter column sha256_recorded_at set not null");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  for (const migration of migrations) {
    const applied = await client.query<{ name: string; sha256: string }>(
      "select name from schema_migrations where name = $1",
      [migration.name],
    );
    if (applied.rowCount) continue;

    await client.query("begin");
    try {
      await client.query(migration.contents.toString("utf8"));
      await client.query("insert into schema_migrations (name,sha256) values ($1,$2)", [migration.name, migration.sha256]);
      await client.query("commit");
      console.log(`[迁移] 已应用 ${migration.name}`);
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
