import { describe, expect, it } from "vitest";
import { computeDescriptionDeterministicFeatures } from "../src/derived/descriptionDeterministic.js";

describe("descriptionDeterministic", () => {
  it("computes timestamps, urls, domains, hashtags and mentions", () => {
    const description = [
      "Suscríbete para más contenido.",
      "00:00 Intro",
      "Visita https://example.com/guide y https://bit.ly/deal.",
      "#AI @canal"
    ].join("\n");

    const result = computeDescriptionDeterministicFeatures({
      title: "Guia AI",
      description
    });

    expect(result.features.desc_len_chars).toBe(description.length);
    expect(result.features.line_count).toBe(4);
    expect(result.features.has_timestamps).toBe(true);
    expect(result.features.url_count).toBe(2);
    expect(result.features.urls[0]?.url).toBe("https://example.com/guide");
    expect(result.features.urls[1]?.isShortener).toBe(true);
    expect(result.features.domain_counts).toEqual([
      { domain: "bit.ly", count: 1 },
      { domain: "example.com", count: 1 }
    ]);
    expect(result.features.hashtag_count).toBe(1);
    expect(result.features.mentions_count).toBe(1);
    expect(result.features.cta_count.subscribe).toBeGreaterThan(0);
    expect(result.features.cta_in_first_200_chars).toBe(true);
  });

  it("computes disclosure flags and evidence spans", () => {
    const description =
      "This video is sponsored by Acme. Affiliate link: https://shop.example.com/deal. Sources: https://docs.example.org/ref";

    const result = computeDescriptionDeterministicFeatures({
      title: "Acme review",
      description
    });

    expect(result.features.has_sponsor_disclosure).toBe(true);
    expect(result.features.has_affiliate_disclosure).toBe(true);
    expect(result.features.has_credits_sources).toBe(true);

    const sponsorEvidence = result.evidence.sponsorDisclosureMatches[0];
    expect(sponsorEvidence).toBeTruthy();
    expect(sponsorEvidence?.snippet.toLowerCase()).toContain("sponsored");
    expect(description.slice(sponsorEvidence!.charStart, sponsorEvidence!.charEnd)).toBe(sponsorEvidence?.snippet);

    const affiliateEvidence = result.evidence.affiliateDisclosureMatches[0];
    expect(affiliateEvidence).toBeTruthy();
    expect(description.slice(affiliateEvidence!.charStart, affiliateEvidence!.charEnd)).toBe(affiliateEvidence?.snippet);

    const sourcesEvidence = result.evidence.creditsSourcesMatches[0];
    expect(sourcesEvidence).toBeTruthy();
    expect(description.slice(sourcesEvidence!.charStart, sourcesEvidence!.charEnd)).toBe(sourcesEvidence?.snippet);
  });

  it("computes title/description token overlap with jaccard evidence", () => {
    const result = computeDescriptionDeterministicFeatures({
      title: "AI pipeline tutorial",
      description: "In this tutorial we build an AI pipeline for beginners"
    });

    expect(result.features.title_desc_overlap_jaccard).toBeGreaterThan(0);
    expect(result.features.title_desc_overlap_tokens.titleTokens).toEqual(["ai", "pipeline", "tutorial"]);
    expect(result.features.title_desc_overlap_tokens.hitTokens).toEqual(["ai", "pipeline", "tutorial"]);
  });
});
