export type ErrorKind =
  | "network_timeout"
  | "rate_limited"
  | "invalid_response"
  | "fs_error"
  | "worker_crash"
  | "schema_validation_failed"
  | "auth_error"
  | "not_found"
  | "unknown";

export interface ClassifiedError {
  code: string;
  kind: ErrorKind;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.toLowerCase();
  }
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  return "";
}

function toCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "unknown";
  }

  const value = (error as { code?: unknown }).code;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "unknown";
}

export function classifyError(error: unknown): ClassifiedError {
  const code = toCode(error);
  const message = toMessage(error);

  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    message.includes("timeout")
  ) {
    return { code, kind: "network_timeout" };
  }

  if (code === "429" || message.includes("rate limit") || message.includes("too many requests")) {
    return { code, kind: "rate_limited" };
  }

  if (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EISDIR" ||
    code === "ENOTDIR" ||
    message.includes("invalid export path") ||
    message.includes("invalid cache path")
  ) {
    return { code, kind: "fs_error" };
  }

  if (
    message.includes("worker exited") ||
    message.includes("worker crashed") ||
    message.includes("worker timeout") ||
    message.includes("local asr worker exited") ||
    message.includes("autogen worker exited")
  ) {
    return { code, kind: "worker_crash" };
  }

  if (message.includes("invalid") && (message.includes("schema") || message.includes("json"))) {
    return { code, kind: "schema_validation_failed" };
  }

  if (message.includes("unauthorized") || message.includes("forbidden") || code === "401" || code === "403") {
    return { code, kind: "auth_error" };
  }

  if (message.includes("not found") || code === "404" || code === "ENOENT") {
    return { code, kind: "not_found" };
  }

  if (message.includes("invalid response") || message.includes("did not contain")) {
    return { code, kind: "invalid_response" };
  }

  return { code, kind: "unknown" };
}

