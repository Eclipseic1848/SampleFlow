import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "sampleflow_session";
export const CSRF_COOKIE = "sampleflow_csrf";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export function createCsrfToken(): { token: string; tokenHash: string } {
  return createSessionToken();
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
