import assert from "node:assert/strict";
import test from "node:test";
import { withTestApi } from "./test-support/test-api.js";
import { withMigratedTestDatabase } from "./test-support/test-database.js";

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
