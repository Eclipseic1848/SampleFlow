import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db.js";

const app = await buildApp();

const close = async () => {
  await app.close();
  await db.end();
};

process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: config.port, host: "0.0.0.0" });
