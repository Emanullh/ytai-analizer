import { describe, expect, it } from "vitest";
import { sanitizeTranscript } from "../src/utils/transcript.js";

describe("sanitizeTranscript", () => {
  it("keeps regular transcripts unchanged", () => {
    const result = sanitizeTranscript("Esto es un transcript normal.");

    expect(result).toEqual({
      transcript: "Esto es un transcript normal.",
      cleaned: false
    });
  });

  it('removes trailing "New thinking." artifact exactly at the end', () => {
    const result = sanitizeTranscript("Contenido final.\n\nNew thinking.  ");

    expect(result).toEqual({
      transcript: "Contenido final.",
      cleaned: true
    });
  });
});
