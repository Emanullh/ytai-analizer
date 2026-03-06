import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function writeTranscriptArtifact(filePath: string, args: { videoId: string; source?: "captions" | "asr" | "none"; text: string }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const rows = [
    JSON.stringify({
      type: "meta",
      videoId: args.videoId,
      source: args.source ?? "captions",
      status: args.text.trim() ? "ok" : "missing",
      language: "en",
      model: null,
      computeType: null,
      createdAt: "2026-03-02T00:00:00.000Z",
      transcriptCleaned: false
    }),
    JSON.stringify({
      type: "segment",
      i: 0,
      startSec: 0,
      endSec: 10,
      text: args.text,
      confidence: null
    })
  ];
  await fs.writeFile(filePath, `${rows.join("\n")}\n`, "utf-8");
}

async function writeDerivedArtifact(filePath: string, args: { videoId: string; llmPresent: boolean }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        schemaVersion: "derived.video_features.v1",
        videoId: args.videoId,
        computedAt: "2026-03-02T00:00:00.000Z",
        titleFeatures: {
          deterministic: { title_len_chars: 10, title_transcript_sim_cosine: 0.1 },
          llm: args.llmPresent ? { schemaVersion: "derived.title_llm.v1", promise_type: [], curiosity_gap_type: [] } : null
        },
        descriptionFeatures: {
          deterministic: { desc_len_chars: 20, urls: [], evidence: {} },
          llm: args.llmPresent ? { schemaVersion: "derived.description_llm.v1", linkPurpose: [] } : null,
          warnings: []
        },
        transcriptFeatures: {
          deterministic: { title_keyword_coverage: 0.5 },
          llm: args.llmPresent ? { schemaVersion: "derived.transcript_llm.v1", sponsor_segments: [], cta_segments: [] } : null,
          warnings: []
        },
        thumbnailFeatures: {
          deterministic: {
            thumbnailLocalPath: "thumbnails/video123.jpg",
            fileSizeBytes: 100,
            imageWidth: 100,
            imageHeight: 100,
            aspectRatio: 1,
            ocrText: "text",
            ocrConfidenceMean: 0.8,
            ocrBoxes: [],
            ocrCharCount: 4,
            ocrWordCount: 1,
            textAreaRatio: 0.1,
            brightnessMean: 0.5,
            contrastStd: 0.5,
            colorfulness: 0.5,
            sharpnessLaplacianVar: 0.5,
            edgeDensity: 0.5,
            thumb_ocr_title_overlap_jaccard: 0.1,
            thumb_ocr_title_overlap_tokens: { titleTokens: [], ocrTokens: [], overlapTokens: [] },
            hasBigText: false
          },
          llm: args.llmPresent ? { schemaVersion: "derived.thumbnail_llm.v1", styleTags: [] } : null,
          warnings: []
        }
      },
      null,
      2
    ),
    "utf-8"
  );
}

describe("exportCacheService", () => {
  let tempDir = "";
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-export-cache-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns full cache hit when files and hashes match", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    const service = await import("../src/services/exportCacheService.js");

    const exportsRoot = path.join(tempDir, "exports");
    const channelFolderPath = path.join(exportsRoot, "Canal_Demo");
    await fs.mkdir(path.join(channelFolderPath, "thumbnails"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "raw", "transcripts"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "derived", "video_features"), { recursive: true });
    const thumbnailPath = path.join(channelFolderPath, "thumbnails", "video123.jpg");
    const transcriptPath = path.join(channelFolderPath, "raw", "transcripts", "video123.jsonl");
    const derivedPath = path.join(channelFolderPath, "derived", "video_features", "video123.json");
    await fs.writeFile(thumbnailPath, Buffer.from("thumbnail-123"));
    await writeTranscriptArtifact(transcriptPath, { videoId: "video123", text: "cache transcript" });
    await writeDerivedArtifact(derivedPath, { videoId: "video123", llmPresent: true });

    const hashes = await service.computeHashes({
      title: "Video cache title",
      description: "Description cache",
      transcriptText: "cache transcript",
      transcriptSource: "captions",
      thumbnailFilePath: thumbnailPath
    });

    const index = await service.loadCacheIndex({
      exportsRoot,
      channelFolderPath,
      channelId: "UC_CACHE",
      exportVersion: "1.1"
    });
    service.updateVideoCacheEntry({
      index,
      timeframe: "6m",
      videoId: "video123",
      entry: service.buildCacheEntry({
        videoId: "video123",
        hashes,
        status: {
          rawTranscript: "ok",
          thumbnail: "ok",
          derived: "ok",
          warnings: []
        }
      })
    });
    await service.saveCacheIndex({ exportsRoot, channelFolderPath, index });

    const result = await service.checkVideoCache({
      exportsRoot,
      channelFolderPath,
      index,
      timeframe: "6m",
      videoId: "video123",
      currentHashes: hashes
    });

    expect(result.hit).toBe("full");
    expect(result.plan.needThumbnailDownload).toBe(false);
    expect(result.plan.needTranscriptFetch).toBe(false);
    expect(result.plan.needDerivedParts.titleDeterministic).toBe(false);
    expect(result.plan.needDerivedParts.titleLlm).toBe(false);
    expect(result.plan.needDerivedParts.thumbnailDeterministic).toBe(false);
  });

  it("supports llm upgrade path when llm fields are missing and API key is present", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    const service = await import("../src/services/exportCacheService.js");

    const exportsRoot = path.join(tempDir, "exports");
    const channelFolderPath = path.join(exportsRoot, "Canal_Demo");
    await fs.mkdir(path.join(channelFolderPath, "thumbnails"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "raw", "transcripts"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "derived", "video_features"), { recursive: true });
    const thumbnailPath = path.join(channelFolderPath, "thumbnails", "video123.jpg");
    const transcriptPath = path.join(channelFolderPath, "raw", "transcripts", "video123.jsonl");
    const derivedPath = path.join(channelFolderPath, "derived", "video_features", "video123.json");
    await fs.writeFile(thumbnailPath, Buffer.from("thumbnail-123"));
    await writeTranscriptArtifact(transcriptPath, { videoId: "video123", text: "cache transcript" });
    await writeDerivedArtifact(derivedPath, { videoId: "video123", llmPresent: false });

    const hashes = await service.computeHashes({
      title: "Video cache title",
      description: "Description cache",
      transcriptText: "cache transcript",
      transcriptSource: "captions",
      thumbnailFilePath: thumbnailPath
    });

    const index = await service.loadCacheIndex({
      exportsRoot,
      channelFolderPath,
      channelId: "UC_CACHE",
      exportVersion: "1.1"
    });
    service.updateVideoCacheEntry({
      index,
      timeframe: "6m",
      videoId: "video123",
      entry: service.buildCacheEntry({
        videoId: "video123",
        hashes,
        status: {
          rawTranscript: "ok",
          thumbnail: "ok",
          derived: "partial",
          warnings: []
        }
      })
    });

    const result = await service.checkVideoCache({
      exportsRoot,
      channelFolderPath,
      index,
      timeframe: "6m",
      videoId: "video123",
      currentHashes: hashes
    });

    expect(result.hit).toBe("partial");
    expect(result.plan.needDerivedParts.titleLlm).toBe(true);
    expect(result.plan.needDerivedParts.descriptionLlm).toBe(true);
    expect(result.plan.needDerivedParts.transcriptLlm).toBe(true);
    expect(result.plan.needDerivedParts.thumbnailLlm).toBe(true);
    expect(result.plan.needDerivedParts.titleDeterministic).toBe(false);
    expect(result.plan.needDerivedParts.thumbnailDeterministic).toBe(false);
  });

  it("does not invalidate cached llm outputs when OPENAI_API_KEY is missing", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "";
    const service = await import("../src/services/exportCacheService.js");

    const exportsRoot = path.join(tempDir, "exports");
    const channelFolderPath = path.join(exportsRoot, "Canal_Demo");
    await fs.mkdir(path.join(channelFolderPath, "thumbnails"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "raw", "transcripts"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "derived", "video_features"), { recursive: true });
    const thumbnailPath = path.join(channelFolderPath, "thumbnails", "video123.jpg");
    const transcriptPath = path.join(channelFolderPath, "raw", "transcripts", "video123.jsonl");
    const derivedPath = path.join(channelFolderPath, "derived", "video_features", "video123.json");
    await fs.writeFile(thumbnailPath, Buffer.from("thumbnail-123"));
    await writeTranscriptArtifact(transcriptPath, { videoId: "video123", text: "cache transcript" });
    await writeDerivedArtifact(derivedPath, { videoId: "video123", llmPresent: true });

    const hashes = await service.computeHashes({
      title: "Video cache title",
      description: "Description cache",
      transcriptText: "cache transcript",
      transcriptSource: "captions",
      thumbnailFilePath: thumbnailPath
    });

    const index = await service.loadCacheIndex({
      exportsRoot,
      channelFolderPath,
      channelId: "UC_CACHE",
      exportVersion: "1.1"
    });
    const entry = service.buildCacheEntry({
      videoId: "video123",
      hashes: {
        ...hashes,
        llmModels: {
          title: "old-title-model",
          description: "old-desc-model",
          transcript: "old-transcript-model",
          thumbnail: "old-thumb-model"
        }
      },
      status: {
        rawTranscript: "ok",
        thumbnail: "ok",
        derived: "ok",
        warnings: []
      }
    });
    service.updateVideoCacheEntry({
      index,
      timeframe: "6m",
      videoId: "video123",
      entry
    });

    const result = await service.checkVideoCache({
      exportsRoot,
      channelFolderPath,
      index,
      timeframe: "6m",
      videoId: "video123",
      currentHashes: hashes
    });

    expect(result.hit).toBe("full");
    expect(result.plan.needDerivedParts.titleLlm).toBe(false);
    expect(result.plan.needDerivedParts.descriptionLlm).toBe(false);
    expect(result.plan.needDerivedParts.transcriptLlm).toBe(false);
    expect(result.plan.needDerivedParts.thumbnailLlm).toBe(false);
  });

  it("invalidates only thumbnail deterministic with ocr-only mode when ocr config changes", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.THUMB_OCR_LANGS = "eng";
    const service = await import("../src/services/exportCacheService.js");

    const exportsRoot = path.join(tempDir, "exports");
    const channelFolderPath = path.join(exportsRoot, "Canal_Demo");
    await fs.mkdir(path.join(channelFolderPath, "thumbnails"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "raw", "transcripts"), { recursive: true });
    await fs.mkdir(path.join(channelFolderPath, "derived", "video_features"), { recursive: true });
    const thumbnailPath = path.join(channelFolderPath, "thumbnails", "video123.jpg");
    const transcriptPath = path.join(channelFolderPath, "raw", "transcripts", "video123.jsonl");
    const derivedPath = path.join(channelFolderPath, "derived", "video_features", "video123.json");
    await fs.writeFile(thumbnailPath, Buffer.from("thumbnail-123"));
    await writeTranscriptArtifact(transcriptPath, { videoId: "video123", text: "cache transcript" });
    await writeDerivedArtifact(derivedPath, { videoId: "video123", llmPresent: true });

    const oldHashes = await service.computeHashes({
      title: "Video cache title",
      description: "Description cache",
      transcriptText: "cache transcript",
      transcriptSource: "captions",
      thumbnailFilePath: thumbnailPath
    });

    const index = await service.loadCacheIndex({
      exportsRoot,
      channelFolderPath,
      channelId: "UC_CACHE",
      exportVersion: "1.1"
    });
    service.updateVideoCacheEntry({
      index,
      timeframe: "6m",
      videoId: "video123",
      entry: service.buildCacheEntry({
        videoId: "video123",
        hashes: oldHashes,
        status: {
          rawTranscript: "ok",
          thumbnail: "ok",
          derived: "ok",
          warnings: []
        }
      })
    });

    process.env.THUMB_OCR_LANGS = "eng+spa";
    vi.resetModules();
    const serviceWithNewConfig = await import("../src/services/exportCacheService.js");
    const newHashes = await serviceWithNewConfig.computeHashes({
      title: "Video cache title",
      description: "Description cache",
      transcriptText: "cache transcript",
      transcriptSource: "captions",
      thumbnailFilePath: thumbnailPath
    });
    const result = await serviceWithNewConfig.checkVideoCache({
      exportsRoot,
      channelFolderPath,
      index,
      timeframe: "6m",
      videoId: "video123",
      currentHashes: newHashes
    });

    expect(result.hit).toBe("partial");
    expect(result.plan.needDerivedParts.thumbnailDeterministic).toBe(true);
    expect(result.plan.needDerivedParts.thumbnailDeterministicMode).toBe("ocr_only");
    expect(result.plan.needDerivedParts.thumbnailLlm).toBe(false);
    expect(result.plan.needDerivedParts.titleDeterministic).toBe(false);
  });

  it("normalizes legacy OCR engine env values to the python OCR hash", async () => {
    process.env.THUMB_OCR_ENGINE = "tesseractjs";
    const legacyService = await import("../src/services/exportCacheService.js");
    const legacyHash = legacyService.computeOcrConfigHash({ langs: "eng", downscaleWidth: 256 });

    vi.resetModules();
    process.env.THUMB_OCR_ENGINE = "python";
    const pythonService = await import("../src/services/exportCacheService.js");
    const pythonHash = pythonService.computeOcrConfigHash({ langs: "eng", downscaleWidth: 256 });

    expect(legacyHash).toBe(pythonHash);
  });
});
