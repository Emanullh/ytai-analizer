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
