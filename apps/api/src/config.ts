import { networkInterfaces } from "node:os";

const nodeEnv = process.env.NODE_ENV ?? "development";

export function developmentOriginsFor(localIpv4Addresses: readonly string[]): string[] {
  const hosts = [...new Set(["localhost", "127.0.0.1", ...localIpv4Addresses])];
  return hosts.flatMap((host) => [`http://${host}:5174`, `http://${host}:4174`]);
}

const localIpv4Addresses = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal)
  .map((address) => address.address);
const developmentOrigins = developmentOriginsFor(localIpv4Addresses);

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
  trustProxy: process.env.TRUST_PROXY_CIDR ?? false,
} as const;
