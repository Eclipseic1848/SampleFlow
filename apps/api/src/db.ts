import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const db = new Pool({
  ...(config.databaseUrl ? { connectionString: config.databaseUrl } : {
    host: config.databaseHost,
    port: config.databasePort,
    database: config.databaseName,
    user: config.databaseUser,
    password: config.databasePassword,
  }),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function checkDatabase(): Promise<void> {
  await db.query("select 1");
}
