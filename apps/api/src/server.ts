import { buildApp } from "./app.js";
import { config } from "./config.js";
import { checkDatabaseSchema, databaseReadinessReason, db } from "./db.js";
import { writeProcessLog } from "./observability.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let databaseReady = false;

try {
  await checkDatabaseSchema();
  databaseReady = true;
  const runningApp = await buildApp();
  app = runningApp;
  const e2eReadyToken = process.env.NODE_ENV === "test" ? process.env.SAMPLEFLOW_E2E_READY_TOKEN : undefined;
  if (e2eReadyToken) runningApp.get("/api/__e2e/ready", async () => ({ token: e2eReadyToken }));

  const close = async () => {
    await runningApp.close();
    await db.end();
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  const logLevel = runningApp.log.level;
  runningApp.log.level = "silent";
  try {
    await runningApp.listen({ port: config.port, host: "0.0.0.0" });
  } finally {
    runningApp.log.level = logLevel;
  }
  writeProcessLog("startup", "STARTUP_SUCCEEDED", 200, "success");
} catch (error) {
  writeProcessLog(
    databaseReady ? "startup" : "database.readiness",
    databaseReady ? "STARTUP_FAILED" : databaseReadinessReason(error),
    503,
  );
  if (app) await app.close();
  await db.end();
  process.exitCode = 1;
}
