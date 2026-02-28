export interface TranscriptSegment {
  startSec: number | null;
  endSec: number | null;
  text: string;
  confidence: number | null;
}

export interface TranscriptAsrMeta {
  model?: string;
  computeType?: string;
}
