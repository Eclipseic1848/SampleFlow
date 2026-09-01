import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { config } from "./config.js";
import { checkDatabaseSchema, db, type Database } from "./db.js";
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
  logger?: boolean;
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
  const app = Fastify({ logger: options.logger ?? true, trustProxy: options.trustProxy ?? config.trustProxy });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : null;
    const errorCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
    if (statusCode && statusCode < 500 && errorCode && SAFE_FASTIFY_CLIENT_ERRORS.has(errorCode)) return reply.send(error);
    request.log.error({ err: error, requestId: request.id }, "API 未知异常");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "服务暂时不可用，请稍后重试",
      requestId: request.id,
    });
  });

  await app.register(cookie);
  await registerAuth(app, database, options.clock);
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

  app.get("/api/ready", async (_request, reply) => {
    try {
      await checkDatabaseSchema(database);
      return { status: "ready", database: "connected" };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({
        status: "not_ready",
        database: "schema_outdated",
        message: "数据库结构未就绪，请先执行 db:migrate 作业",
      });
    }
  });

  return app;
}
