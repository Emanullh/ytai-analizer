import sharp from "sharp";
import { env } from "../../config/env.js";

export interface ThumbnailRgbData {
  width: number;
  height: number;
  rgbBuffer: Buffer;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function toGrayscale(rgbBuffer: Buffer): Float64Array {
  const grayscale = new Float64Array(Math.floor(rgbBuffer.length / 3));
  let cursor = 0;

  for (let i = 0; i + 2 < rgbBuffer.length; i += 3) {
    const r = rgbBuffer[i];
    const g = rgbBuffer[i + 1];
    const b = rgbBuffer[i + 2];
    grayscale[cursor] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    cursor += 1;
  }

  return grayscale;
}

export async function decodeThumbnailToRgb(thumbnailPath: string): Promise<ThumbnailRgbData> {
  const maxWidth = Math.max(32, env.thumbVisionDownscaleWidth);

  const { data, info } = await sharp(thumbnailPath)
    .rotate()
    .resize({ width: maxWidth, fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!info.width || !info.height) {
    throw new Error("Unable to decode thumbnail image dimensions");
  }

  if (info.channels === 3) {
    return {
      width: info.width,
      height: info.height,
      rgbBuffer: data
    };
  }

  const rgbBuffer = Buffer.alloc(info.width * info.height * 3);
  const channels = Math.max(1, info.channels);
  for (let i = 0, out = 0; i < data.length; i += channels, out += 3) {
    const value = data[i];
    rgbBuffer[out] = value;
    rgbBuffer[out + 1] = channels > 1 ? data[i + 1] : value;
    rgbBuffer[out + 2] = channels > 2 ? data[i + 2] : value;
  }

  return {
    width: info.width,
    height: info.height,
    rgbBuffer
  };
}

export function computeBrightnessContrast(rgbBuffer: Buffer): { brightnessMean: number; contrastStd: number } {
  const grayscale = toGrayscale(rgbBuffer);
  if (grayscale.length === 0) {
    return { brightnessMean: 0, contrastStd: 0 };
  }

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < grayscale.length; i += 1) {
    const value = grayscale[i];
    sum += value;
    sumSq += value * value;
  }

  const mean = sum / grayscale.length;
  const variance = Math.max(0, sumSq / grayscale.length - mean * mean);
  const std = Math.sqrt(variance);

  return {
    brightnessMean: clamp01(mean / 255),
    contrastStd: clamp01(std / 128)
  };
}

export function computeColorfulness(rgbBuffer: Buffer): number {
  const pixelCount = Math.floor(rgbBuffer.length / 3);
  if (pixelCount === 0) {
    return 0;
  }

  let rgSum = 0;
  let rgSqSum = 0;
  let ybSum = 0;
  let ybSqSum = 0;

  for (let i = 0; i + 2 < rgbBuffer.length; i += 3) {
    const r = rgbBuffer[i];
    const g = rgbBuffer[i + 1];
    const b = rgbBuffer[i + 2];

    const rg = r - g;
    const yb = 0.5 * (r + g) - b;

    rgSum += rg;
    rgSqSum += rg * rg;
    ybSum += yb;
    ybSqSum += yb * yb;
  }

  const rgMean = rgSum / pixelCount;
  const ybMean = ybSum / pixelCount;

  const rgStd = Math.sqrt(Math.max(0, rgSqSum / pixelCount - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSqSum / pixelCount - ybMean * ybMean));

  const stdRoot = Math.sqrt(rgStd * rgStd + ybStd * ybStd);
  const meanRoot = Math.sqrt(rgMean * rgMean + ybMean * ybMean);
  const haslerColorfulness = stdRoot + 0.3 * meanRoot;

  return clamp01(haslerColorfulness / 150);
}

export function computeSharpnessLaplacianVar(rgbBuffer: Buffer, width: number, height: number): number {
  if (width < 3 || height < 3) {
    return 0;
  }

  const grayscale = toGrayscale(rgbBuffer);
  let count = 0;
  let sum = 0;
  let sumSq = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const laplacian =
        grayscale[idx - width] + grayscale[idx + width] + grayscale[idx - 1] + grayscale[idx + 1] - 4 * grayscale[idx];

      sum += laplacian;
      sumSq += laplacian * laplacian;
      count += 1;
    }
  }

  if (count === 0) {
    return 0;
  }

  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return clamp01(variance / 20_000);
}

export function computeEdgeDensity(
  rgbBuffer: Buffer,
  width: number,
  height: number,
  threshold = 120
): number {
  if (width < 3 || height < 3) {
    return 0;
  }

  const grayscale = toGrayscale(rgbBuffer);
  let edgeCount = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;

      const topLeft = grayscale[idx - width - 1];
      const top = grayscale[idx - width];
      const topRight = grayscale[idx - width + 1];
      const left = grayscale[idx - 1];
      const right = grayscale[idx + 1];
      const bottomLeft = grayscale[idx + width - 1];
      const bottom = grayscale[idx + width];
      const bottomRight = grayscale[idx + width + 1];

      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = topLeft + 2 * top + topRight - bottomLeft - 2 * bottom - bottomRight;

      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude > threshold) {
        edgeCount += 1;
      }
      count += 1;
    }
  }

  return clamp01(count > 0 ? edgeCount / count : 0);
}
