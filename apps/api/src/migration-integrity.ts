import { createHash } from "node:crypto";

export function migrationSha256(contents: Uint8Array | string): string {
  const text = typeof contents === "string" ? contents : Buffer.from(contents).toString("utf8");
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}
