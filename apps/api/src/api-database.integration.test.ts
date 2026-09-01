import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkDatabaseSchema, DatabaseReadinessError, type Database } from "./db.js";
import { migrationSha256 } from "./migration-integrity.js";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase, withTestDatabase } from "./test-support/test-database.js";

const execFileAsync = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const migrationsRoot = fileURLToPath(new URL("../migrations/", import.meta.url));

async function expectedMigrations(): Promise<Array<{ name: string; sha256: string }>> {
  const names = (await readdir(migrationsRoot)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    sha256: migrationSha256(await readFile(`${migrationsRoot}${name}`)),
  })));
}

function readinessDatabase(rows: Array<{ name: string; sha256: string }>): Database {
  return {
    query: async (sql: string) => sql === "select 1" ? { rows: [{ "?column?": 1 }] } : { rows },
  } as unknown as Database;
}

test("连接检查后数据库中断仍报告不可用而不是结构落后", async () => {
  let queryCount = 0;
  const database = {
    query: async () => {
      queryCount += 1;
      if (queryCount === 1) return { rows: [{ "?column?": 1 }] };
      throw Object.assign(new Error("connection interrupted"), { code: "ECONNRESET" });
    },
  } as unknown as Database;

  await assert.rejects(checkDatabaseSchema(database), (error: unknown) => {
    assert.ok(error instanceof DatabaseReadinessError);
    assert.equal(error.reasonCode, "DB_UNAVAILABLE");
    return true;
  });
});

test("数据库结构未迁移时 API 进程停止且不输出内部栈", async () => {
  await withTestDatabase(async (database) => {
    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: apiRoot,
        env: { ...process.env, API_PORT: "3103", DATABASE_URL: database.url, NODE_ENV: "production" },
        encoding: "utf8",
        timeout: 5_000,
      }),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string; stdout?: string };
        assert.equal(failure.code, 1);
        const record = JSON.parse((failure.stdout ?? "").trim()) as Record<string, unknown>;
        assert.equal(record.operation, "database.readiness");
        assert.equal(record.result, "failure");
        assert.equal(record.reasonCode, "SCHEMA_OUTDATED");
        assert.equal(failure.stderr, "");
        assert.doesNotMatch(failure.stdout ?? "", /\n\s+at\s/);
        return true;
      },
    );
  });
});

test("数据库结构未迁移时就绪检查拒绝流量并给出运维提示", async () => {
  await withTestDatabase(async (database) => {
    await withTestApi(database.url, async (app) => {
      const response = await app.inject({ method: "GET", url: "/api/ready" });

      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), {
        status: "not_ready",
        database: "schema_outdated",
        message: "数据库结构未就绪，请先执行 db:migrate 作业",
      });
    });
  });
});

test("数据库就绪检查拒绝缺失、未知和内容变化的迁移，仅接受完整一致集合", async () => {
  const expected = await expectedMigrations();

  await assert.rejects(checkDatabaseSchema(readinessDatabase(expected.slice(0, -1))), /缺失迁移/);
  await assert.rejects(
    checkDatabaseSchema(readinessDatabase([...expected, { name: "999_unknown.sql", sha256: "0".repeat(64) }])),
    /未知迁移/,
  );
  await assert.rejects(
    checkDatabaseSchema(readinessDatabase(expected.map((migration, index) => index === 0
      ? { ...migration, sha256: "0".repeat(64) }
      : migration))),
    /内容校验失败/,
  );
  await assert.doesNotReject(checkDatabaseSchema(readinessDatabase(expected)));
});

test("迁移内容哈希不受 Windows 与 Linux 换行差异影响", () => {
  assert.equal(migrationSha256("select 1;\r\nselect 2;\r\n"), migrationSha256("select 1;\nselect 2;\n"));
});

test("API 可在同一进程重复连接隔离数据库", async () => {
  await withMigratedTestDatabase(async (database) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await withTestApi(database.url, async (app) => {
        const response = await app.inject({ method: "GET", url: "/api/ready" });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { status: "ready", database: "connected" });
      });
    }
  });
});
