import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "../app.js";
import { assertTestDatabaseUrl } from "./test-database.js";

const { Pool } = pg;

export async function withTestApi<T>(
  databaseUrl: string,
  run: (app: FastifyInstance) => Promise<T>,
  options: Readonly<{
    clock?: () => Date;
    passwordVerifier?: (password: string, hash: string, salt: string) => Promise<boolean>;
    trustProxy?: boolean | string | string[];
  }> = {},
): Promise<T> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境禁止启动测试 API");
  }

  assertTestDatabaseUrl(databaseUrl);
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.searchParams.set("application_name", "sampleflow-api-runtime");
  const database = new Pool({ connectionString: runtimeUrl.toString() });
  const app = await buildApp({ database, logger: false, ...options });
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
