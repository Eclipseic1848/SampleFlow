const nodeEnv = process.env.NODE_ENV ?? "development";
const developmentOrigins = [
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:4174",
  "http://127.0.0.1:4174",
];

export const config = {
  port: Number(process.env.API_PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  databaseHost: process.env.DB_HOST ?? "127.0.0.1",
  databasePort: Number(process.env.DB_PORT ?? 55432),
  databaseName: process.env.DB_NAME ?? "sampleflow",
  databaseUser: process.env.DB_USER ?? "sampleflow",
  databasePassword: process.env.DB_PASSWORD ?? "sampleflow_dev",
  nodeEnv,
  allowedOrigins: process.env.APP_ORIGINS
    ? process.env.APP_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
    : nodeEnv === "production" ? [] : developmentOrigins,
  trustProxy: process.env.TRUST_PROXY === "true",
} as const;
