import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { env } from "../../config/env.js";

export interface OcrBox {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  text: string;
}

export interface OcrResult {
  text: string;
  confidenceMean: number;
  boxes: OcrBox[];
}

interface TesseractLike {
  createWorker: (
    langs?: string | string[],
    oem?: unknown,
    options?: { logger?: (message: unknown) => void },
    config?: unknown
  ) => Promise<{
    recognize: (image: Buffer | string) => Promise<{
      data?: {
        text?: string;
        confidence?: number;
        words?: Array<{
          text?: string;
          confidence?: number;
          bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
        }>;
      };
    }>;
    terminate: () => Promise<unknown>;
  }>;
  setLogging?: (enabled: boolean) => void;
}

const ocrCache = new Map<string, OcrResult>();
const ocrInFlight = new Map<string, Promise<OcrResult>>();
const workerByLang = new Map<string, Promise<Awaited<ReturnType<TesseractLike["createWorker"]>>>>();

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function normalizeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function cloneResult(result: OcrResult): OcrResult {
  return {
    text: result.text,
    confidenceMean: result.confidenceMean,
    boxes: result.boxes.map((box) => ({ ...box }))
  };
}

function normalizeBox(raw: {
  text?: string;
  confidence?: number;
  bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
}): OcrBox | null {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) {
    return null;
  }

  const x0 = normalizeInt(raw.bbox?.x0);
  const y0 = normalizeInt(raw.bbox?.y0);
  const x1 = normalizeInt(raw.bbox?.x1);
  const y1 = normalizeInt(raw.bbox?.y1);

  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  if (w <= 0 || h <= 0) {
    return null;
  }

  const confidence = clamp01((typeof raw.confidence === "number" ? raw.confidence : 0) / 100);

  return {
    x: x0,
    y: y0,
    w,
    h,
    confidence,
    text
  };
}

function resolveOcrLangs(): string[] {
  return env.thumbOcrLangs
    .split("+")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function loadTesseract(): Promise<TesseractLike> {
  const loaded = (await import("tesseract.js")) as unknown;
  const candidate =
    loaded && typeof loaded === "object" && "default" in (loaded as Record<string, unknown>)
      ? ((loaded as { default: unknown }).default as unknown)
      : loaded;

  if (!candidate || typeof candidate !== "object") {
    throw new Error("tesseract.js module is not available");
  }

  const api = candidate as TesseractLike;
  if (typeof api.createWorker !== "function") {
    throw new Error("tesseract.js createWorker API is not available");
  }

  return api;
}

async function getWorker(): Promise<Awaited<ReturnType<TesseractLike["createWorker"]>>> {
  const langs = resolveOcrLangs();
  const langKey = langs.length > 0 ? langs.join("+") : "eng";

  const existing = workerByLang.get(langKey);
  if (existing) {
    return existing;
  }

  const workerPromise = (async () => {
    const tesseract = await loadTesseract();
    tesseract.setLogging?.(false);
    return tesseract.createWorker(langs.length > 0 ? langs : ["eng"]);
  })();

  workerByLang.set(langKey, workerPromise);
  return workerPromise;
}

async function resolveInput(input: Buffer | string): Promise<{ imageBuffer: Buffer; imageRef: Buffer | string }> {
  if (Buffer.isBuffer(input)) {
    return { imageBuffer: input, imageRef: input };
  }

  const imageBuffer = await fs.readFile(input);
  return {
    imageBuffer,
    imageRef: input
  };
}

async function computeOcr(input: Buffer | string): Promise<OcrResult> {
  const { imageBuffer, imageRef } = await resolveInput(input);

  const fileHash = createHash("sha1").update(imageBuffer).digest("hex");
  const cached = ocrCache.get(fileHash);
  if (cached) {
    return cloneResult(cached);
  }

  const inFlight = ocrInFlight.get(fileHash);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<OcrResult> => {
    const worker = await getWorker();
    const recognized = await worker.recognize(imageRef);

    const data = recognized.data ?? {};
    const words = Array.isArray(data.words) ? data.words : [];
    const boxes = words
      .map((word) => normalizeBox(word))
      .filter((box): box is OcrBox => box !== null);

    const text = typeof data.text === "string" ? data.text.replace(/\s+/g, " ").trim() : "";
    const confidenceFromWords =
      boxes.length > 0 ? boxes.reduce((acc, box) => acc + box.confidence, 0) / boxes.length : null;
    const confidenceMean = clamp01(
      confidenceFromWords ?? ((typeof data.confidence === "number" ? data.confidence : 0) / 100)
    );

    const result: OcrResult = {
      text,
      confidenceMean,
      boxes
    };

    ocrCache.set(fileHash, cloneResult(result));
    return result;
  })();

  ocrInFlight.set(fileHash, task);
  try {
    return await task;
  } finally {
    ocrInFlight.delete(fileHash);
  }
}

export async function runOcr(input: Buffer | string): Promise<OcrResult> {
  if (!env.thumbOcrEnabled) {
    return {
      text: "",
      confidenceMean: 0,
      boxes: []
    };
  }

  return computeOcr(input);
}

export function clearOcrCache(): void {
  ocrCache.clear();
  ocrInFlight.clear();
}

export async function terminateOcrWorkers(): Promise<void> {
  const entries = Array.from(workerByLang.values());
  workerByLang.clear();

  for (const entry of entries) {
    try {
      const worker = await entry;
      await worker.terminate();
    } catch {
      // ignore worker shutdown errors
    }
  }
}
