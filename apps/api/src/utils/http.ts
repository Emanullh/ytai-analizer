import { HttpError } from "./errors.js";

interface RequestOptions {
  timeoutMs?: number;
}

export async function fetchJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const parsedBody = text ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
      const errorMessage =
        typeof parsedBody === "object" &&
        parsedBody !== null &&
        "error" in parsedBody &&
        typeof (parsedBody as { error?: { message?: string } }).error?.message === "string"
          ? (parsedBody as { error: { message: string } }).error.message
          : `Request failed with status ${response.status}`;
      throw new HttpError(response.status, errorMessage);
    }

    return parsedBody as T;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, `Timeout while requesting: ${url}`);
    }

    throw new HttpError(502, error instanceof Error ? error.message : "Network request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadToBuffer(url: string, timeoutMs = 12_000): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new HttpError(response.status, `Download failed with status ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, `Timeout while downloading: ${url}`);
    }

    throw new HttpError(502, error instanceof Error ? error.message : "Download failed");
  } finally {
    clearTimeout(timeout);
  }
}
