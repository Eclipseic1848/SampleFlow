import { buildApp } from "./app.js";
import { config } from "./config.js";
import { checkDatabaseSchema, db } from "./db.js";

try {
  await checkDatabaseSchema();
  const app = await buildApp();
  const e2eReadyToken = process.env.NODE_ENV === "test" ? process.env.SAMPLEFLOW_E2E_READY_TOKEN : undefined;
  if (e2eReadyToken) app.get("/api/__e2e/ready", async () => ({ token: e2eReadyToken }));

  const close = async () => {
    await app.close();
    await db.end();
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  console.error(error instanceof Error ? error.message : "[启动前置检查] API 启动失败");
  await db.end();
  process.exitCode = 1;
}
