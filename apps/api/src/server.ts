import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { checkDatabase, db } from "./db.js";
import { registerAuth } from "./modules/auth.js";
import { registerPerformance } from "./modules/performance.js";
import { registerGoals } from "./modules/goals.js";
import { registerAdmin } from "./modules/admin.js";
import { registerExports } from "./modules/exports.js";

const app = Fastify({ logger: true });
await app.register(cookie);
await registerAuth(app);
await registerPerformance(app);
await registerGoals(app);
await registerAdmin(app);
await registerExports(app);

app.get("/api/health", async () => ({
  status: "ok",
  service: "sampleflow-api",
  time: new Date().toISOString(),
}));

app.get("/api/ready", async (_request, reply) => {
  try {
    await checkDatabase();
    return { status: "ready", database: "connected" };
  } catch (error) {
    app.log.error(error);
    return reply.code(503).send({ status: "not_ready", database: "unavailable" });
  }
});

const close = async () => {
  await app.close();
  await db.end();
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: config.port, host: "0.0.0.0" });
