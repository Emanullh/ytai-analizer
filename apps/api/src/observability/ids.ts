import { randomUUID } from "node:crypto";

export function newStepId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

