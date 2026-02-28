const TRAILING_ARTIFACTS = ["New thinking."] as const;

export interface SanitizeTranscriptResult {
  transcript: string;
  cleaned: boolean;
}

export function sanitizeTranscript(transcript: string): SanitizeTranscriptResult {
  let cleanedTranscript = transcript;
  let cleaned = false;

  for (const artifact of TRAILING_ARTIFACTS) {
    const artifactPattern = new RegExp(`(?:\\s+)?${escapeRegExp(artifact)}\\s*$`);
    if (!artifactPattern.test(cleanedTranscript)) {
      continue;
    }
    cleanedTranscript = cleanedTranscript.replace(artifactPattern, "").trimEnd();
    cleaned = true;
  }

  return {
    transcript: cleanedTranscript,
    cleaned
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
