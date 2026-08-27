export const config = {
  port: Number(process.env.API_PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  databaseHost: process.env.DB_HOST ?? "127.0.0.1",
  databasePort: Number(process.env.DB_PORT ?? 55432),
  databaseName: process.env.DB_NAME ?? "sampleflow",
  databaseUser: process.env.DB_USER ?? "sampleflow",
  databasePassword: process.env.DB_PASSWORD ?? "sampleflow_dev",
  nodeEnv: process.env.NODE_ENV ?? "development",
} as const;
