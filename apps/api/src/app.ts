import cookie from "@fastify/cookie";
import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import { config } from "./config.js";
import { checkDatabaseSchema, databaseReadinessReason, db, type Database } from "./db.js";
import { OperationalMetrics, recordOperation, requestOperation } from "./observability.js";
import { registerAdmin } from "./modules/admin.js";
import { registerAuth } from "./modules/auth.js";
import { registerExports } from "./modules/exports.js";
import { registerGoals } from "./modules/goals.js";
import { registerPerformance } from "./modules/performance.js";
import { registerAccountingPeriods } from "./modules/accounting-periods.js";
import { registerImports } from "./modules/imports.js";
import { registerAudits } from "./modules/audits.js";

type BuildAppOptions = {
  clock?: () => Date;
  database?: Database;
  logger?: FastifyServerOptions["logger"];
  passwordVerifier?: (password: string, hash: string, salt: string) => Promise<boolean>;
  trustProxy?: boolean | string | string[];
};

const SAFE_FASTIFY_CLIENT_ERRORS = new Set([
  "FST_ERR_CTP_BODY_TOO_LARGE",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  "FST_ERR_VALIDATION",
]);

export async function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? db;
  const metrics = new OperationalMetrics();
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
    trustProxy: options.trustProxy ?? config.trustProxy,
  });
  app.decorateRequest("operationalOutcome", null);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const observed = metrics.observe(request, reply.statusCode, reply.elapsedTime);
    request.log.info({
      service: "sampleflow-api",
      requestId: request.id,
      method: observed.method,
      routeTemplate: observed.routeTemplate,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      operation: observed.operation,
      result: observed.result,
      reasonCode: observed.reasonCode,
      remoteAddress: request.ip,
    }, "request completed");
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : null;
    const errorCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
    if (statusCode && statusCode < 500 && errorCode && SAFE_FASTIFY_CLIENT_ERRORS.has(errorCode)) {
      if (!request.operationalOutcome) recordOperation(request, requestOperation(request.routeOptions.url ?? "__unmatched__"), "failure", errorCode);
      return reply.send(error);
    }
    if (!request.operationalOutcome) recordOperation(request, requestOperation(request.routeOptions.url ?? "__unmatched__"), "failure", "INTERNAL_ERROR");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "服务暂时不可用，请稍后重试",
      requestId: request.id,
    });
  });

  await app.register(cookie);
  await registerAuth(app, database, options.clock, options.passwordVerifier);
  await registerAccountingPeriods(app, database, options.clock);
  await registerPerformance(app, database, options.clock);
  await registerImports(app, database);
  await registerGoals(app, database);
  await registerAdmin(app, database);
  await registerAudits(app, database);
  await registerExports(app, database, options.clock);

  app.get("/api/health", async () => ({
    status: "ok",
    service: "sampleflow-api",
    time: new Date().toISOString(),
  }));

  app.get("/api/ready", async (request, reply) => {
    try {
      await checkDatabaseSchema(database);
      recordOperation(request, "database.readiness", "success", "DB_READY");
      return { status: "ready", database: "connected" };
    } catch (error) {
      const reasonCode = databaseReadinessReason(error);
      recordOperation(request, "database.readiness", "failure", reasonCode);
      return reply.code(503).send({
        status: "not_ready",
        database: reasonCode === "DB_UNAVAILABLE" ? "unavailable" : "schema_outdated",
        message: reasonCode === "DB_UNAVAILABLE"
          ? "数据库不可用，请检查连接和服务状态"
          : "数据库结构未就绪，请先执行 db:migrate 作业",
      });
    }
  });

  app.get("/internal/metrics", async (_request, reply) => {
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.text());
  });

  return app;
}
