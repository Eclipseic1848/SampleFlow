import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export const PASSWORD_POLICY_MESSAGE = "密码须为 6—128 位可见 ASCII 字符，并包含英文字母、数字和符号";
export const TEMPORARY_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

export function isPasswordAllowed(password: string): boolean {
  return password.length >= 6
    && password.length <= 128
    && /^[\x21-\x7e]+$/.test(password)
    && /[A-Za-z]/.test(password)
    && /[0-9]/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

export function generateTemporaryPassword(): string {
  return `A1!${randomBytes(15).toString("base64url")}`;
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  return { hash: derived.toString("hex"), salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const derived = await scrypt(password, salt, KEY_LENGTH) as Buffer;
  const stored = Buffer.from(hash, "hex");
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}
