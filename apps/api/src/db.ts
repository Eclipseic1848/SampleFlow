import pg, { type Pool as PgPool } from "pg";
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

export type Database = PgPool;

export async function checkDatabase(database: Database = db): Promise<void> {
  await database.query("select 1");
}
