import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";
import type { Database } from "./db.js";
import { recordOperation, requestOperation } from "./observability.js";

test("所有审批写入口归入同一个低基数操作", () => {
  for (const route of [
    "/api/goals/:id/decision",
    "/api/goal-change-requests/:id/accept",
    "/api/goal-change-requests/:id/reject",
    "/api/goal-linkage-decisions/:id/decide",
    "/api/accounting-corrections/:id/approve",
    "/api/accounting-corrections/:id/reject",
    "/api/historical-order-reviews/:id/approve",
    "/api/historical-order-reviews/:id/reject",
  ]) assert.equal(requestOperation(route), "approval");
});

test("结构化日志和有界指标定位核心失败且不泄漏业务值", async () => {
  const output: string[] = [];
  const database = {
    query: async () => { throw new Error("DATABASE-SECRET-CANARY"); },
  } as unknown as Database;
  const app = await buildApp({
    database,
    logger: { level: "info", stream: { write: (line: string) => output.push(line) } },
  });
  app.get("/api/test-observability-error", async () => {
    throw new Error("BUSINESS-DETAIL-CANARY");
  });
  app.get("/api/test-observability-business-failure", async (request) => {
    recordOperation(request, "import", "failure", "IMPORT_PREFLIGHT_BLOCKED");
    return { status: "blocked" };
  });

  try {
    const health = await app.inject({ method: "GET", url: "/api/health?customer=CLIENT-CANARY" });
    assert.equal(health.statusCode, 200);
    assert.equal(typeof health.headers["x-request-id"], "string");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ACCOUNT-CANARY", password: "PASSWORD-CANARY" },
    });
    assert.equal(login.statusCode, 403);

    const approval = await app.inject({ method: "POST", url: "/api/goals/987654321/decision" });
    assert.equal(approval.statusCode, 401);

    const importFailure = await app.inject({
      method: "POST",
      url: "/api/imports/preflight",
      payload: { fileName: "ORDER-CANARY.xlsx", contentBase64: "CUSTOMER-CANARY", configId: "1" },
    });
    assert.equal(importFailure.statusCode, 401);

    const ready = await app.inject({ method: "GET", url: "/api/ready" });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().database, "unavailable");

    const internal = await app.inject({ method: "GET", url: "/api/test-observability-error" });
    assert.equal(internal.statusCode, 500);
    assert.equal(internal.headers["x-request-id"], internal.json().requestId);

    const businessFailure = await app.inject({ method: "GET", url: "/api/test-observability-business-failure" });
    assert.equal(businessFailure.statusCode, 200);

    const metricsResponse = await app.inject({ method: "GET", url: "/internal/metrics" });
    assert.equal(metricsResponse.statusCode, 200);
    const metrics = metricsResponse.body;
    assert.match(metrics, /sampleflow_http_requests_total\{route_template="\/api\/auth\/login",method="POST",status_category="4xx"\} 1/);
    assert.match(metrics, /sampleflow_http_errors_total\{route_template="\/api\/ready",method="GET",status_category="5xx"\} 1/);
    assert.match(metrics, /sampleflow_http_request_duration_seconds_count\{route_template="\/api\/health",method="GET",status_category="2xx"\} 1/);
    assert.match(metrics, /sampleflow_operation_failures_total\{operation="auth.login",result="failure",reason_code="AUTH_ORIGIN_INVALID"\} 1/);
    assert.match(metrics, /sampleflow_operation_failures_total\{operation="approval",result="failure",reason_code="AUTH_REQUIRED"\} 1/);
    assert.match(metrics, /sampleflow_operation_failures_total\{operation="import",result="failure",reason_code="AUTH_REQUIRED"\} 1/);
    assert.match(metrics, /sampleflow_operation_failures_total\{operation="import",result="failure",reason_code="IMPORT_PREFLIGHT_BLOCKED"\} 1/);
    assert.match(metrics, /sampleflow_database_ready 0/);

    const allowedLabels = new Set(["route_template", "method", "status_category", "operation", "result", "reason_code"]);
    for (const labels of metrics.matchAll(/\{([^}]*)\}/g)) {
      for (const label of labels[1]!.matchAll(/(?:^|,)([a-z_]+)=/g)) assert.ok(allowedLabels.has(label[1]!));
    }

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.msg === "request completed");
    assert.equal(records.length, 8);
    for (const record of records) {
      assert.equal(record.service, "sampleflow-api");
      assert.equal(typeof record.time, "number");
      assert.equal(typeof record.level, "number");
      assert.equal(typeof record.requestId, "string");
      assert.equal(typeof record.method, "string");
      assert.equal(typeof record.routeTemplate, "string");
      assert.equal(typeof record.statusCode, "number");
      assert.equal(typeof record.durationMs, "number");
      assert.equal(typeof record.operation, "string");
      assert.equal(typeof record.result, "string");
      assert.equal(typeof record.reasonCode, "string");
      assert.equal(typeof record.remoteAddress, "string");
    }
    assert.equal(records.find((record) => record.routeTemplate === "/api/health")?.requestId, health.headers["x-request-id"]);

    const evidence = `${metrics}\n${output.join("")}`;
    assert.doesNotMatch(evidence, /ACCOUNT-CANARY|PASSWORD-CANARY|CLIENT-CANARY|ORDER-CANARY|CUSTOMER-CANARY|BUSINESS-DETAIL-CANARY|DATABASE-SECRET-CANARY|987654321/);
  } finally {
    await app.close();
  }
});
