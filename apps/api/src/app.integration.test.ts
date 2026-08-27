import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("API 应用可在不监听端口时返回健康状态", async () => {
  const app = await buildApp();

  try {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
  } finally {
    await app.close();
  }
});
