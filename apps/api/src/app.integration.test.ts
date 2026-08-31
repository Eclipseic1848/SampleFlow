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

test("未知 API 异常只返回稳定错误和请求 ID", async () => {
  const app = await buildApp({ logger: false });
  app.get("/api/test-internal-error", async () => {
    throw new Error("sensitive_constraint_name");
  });
  app.get("/api/test-unsafe-client-error", async () => {
    throw Object.assign(new Error("sensitive_client_status"), { statusCode: 400 });
  });
  app.post("/api/test-client-error", async () => ({ ok: true }));

  try {
    const response = await app.inject({ method: "GET", url: "/api/test-internal-error" });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      code: "INTERNAL_ERROR",
      message: "服务暂时不可用，请稍后重试",
      requestId: response.json().requestId,
    });
    assert.equal(typeof response.json().requestId, "string");
    assert.doesNotMatch(response.body, /sensitive_constraint_name/);

    const unsafeClientError = await app.inject({ method: "GET", url: "/api/test-unsafe-client-error" });
    assert.equal(unsafeClientError.statusCode, 500);
    assert.equal(unsafeClientError.json().code, "INTERNAL_ERROR");
    assert.doesNotMatch(unsafeClientError.body, /sensitive_client_status/);

    const clientError = await app.inject({
      method: "POST",
      url: "/api/test-client-error",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(clientError.statusCode, 400);
    assert.notEqual(clientError.json().code, "INTERNAL_ERROR");
  } finally {
    await app.close();
  }
});
