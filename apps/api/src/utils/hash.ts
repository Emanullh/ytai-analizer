import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export function hashStringSha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function hashStringSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashBufferSha1(value: Buffer): string {
  return createHash("sha1").update(value).digest("hex");
}

export function hashBufferSha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFileSha1(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return hashBufferSha1(content);
}

export async function hashFileSha256(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return hashBufferSha256(content);
}
