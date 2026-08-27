import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "../app.js";
import { assertTestDatabaseUrl } from "./test-database.js";

const { Pool } = pg;

export async function withTestApi<T>(
  databaseUrl: string,
  run: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境禁止启动测试 API");
  }

  assertTestDatabaseUrl(databaseUrl);
  const database = new Pool({ connectionString: databaseUrl });
  const app = await buildApp({ database, logger: false });
  try {
    return await run(app);
  } finally {
    try {
      await app.close();
    } finally {
      await database.end();
    }
  }
}
