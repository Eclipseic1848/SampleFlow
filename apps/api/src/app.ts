import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { checkDatabase, db, type Database } from "./db.js";
import { registerAdmin } from "./modules/admin.js";
import { registerAuth } from "./modules/auth.js";
import { registerExports } from "./modules/exports.js";
import { registerGoals } from "./modules/goals.js";
import { registerPerformance } from "./modules/performance.js";

type BuildAppOptions = {
  database?: Database;
  logger?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const database = options.database ?? db;
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cookie);
  await registerAuth(app, database);
  await registerPerformance(app, database);
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
      await checkDatabase(database);
      return { status: "ready", database: "connected" };
    } catch (error) {
      app.log.error(error);
      return reply.code(503).send({ status: "not_ready", database: "unavailable" });
    }
  });

  return app;
}
