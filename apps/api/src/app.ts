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

type BuildAppOptions = {
  clock?: () => Date;
  database?: Database;
  logger?: boolean;
  trustProxy?: boolean | string | string[];
};

export async function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? db;
  const app = Fastify({ logger: options.logger ?? true, trustProxy: options.trustProxy ?? config.trustProxy });

  await app.register(cookie);
  await registerAuth(app, database, options.clock);
  await registerAccountingPeriods(app, database, options.clock);
  await registerPerformance(app, database, options.clock);
  await registerImports(app, database);
  await registerGoals(app, database);
  await registerAdmin(app, database);
  await registerExports(app, database);

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
