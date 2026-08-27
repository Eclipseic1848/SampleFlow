import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

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

