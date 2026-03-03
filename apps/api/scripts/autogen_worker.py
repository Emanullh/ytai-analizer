#!/usr/bin/env python3
import asyncio
import base64
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

AUTOGEN_IMPORT_ERROR: str | None = None
try:
    from autogen_agentchat.agents import AssistantAgent
    from autogen_ext.models.openai import OpenAIChatCompletionClient
except Exception as import_error:  # pragma: no cover - depends on external runtime env
    AUTOGEN_IMPORT_ERROR = str(import_error) or import_error.__class__.__name__
    AssistantAgent = Any  # type: ignore[assignment]
    OpenAIChatCompletionClient = Any  # type: ignore[assignment]

TITLE_SYSTEM_PROMPT = """You are a strict classification agent. You must output ONLY valid JSON (no markdown, no prose).
Task: classify a YouTube video title into closed taxonomies with confidence and evidence spans.

INPUT:
You will receive a JSON payload with:
- videoId (string)
- title (string)
- languageHint ("auto"|"en"|"es")

OUTPUT (MUST match this schema exactly):
{
  "schemaVersion": "llm.title_classifier.v1",
  "videoId": "string",
  "promiseType": [
    { "label": "howto/tutorial|review|news|challenge|comparison|listicle|storytime|reaction|case-study|tooling|explainer",
      "score": 0.0,
      "confidence": 0.0,
      "evidence": [ { "charStart": 0, "charEnd": 0, "snippet": "string" } ]
    }
  ],
  "curiosityGapType": {
    "label": "threat|mystery|contrarian|how-to|controversy|warning|breakdown|unknown",
    "confidence": 0.0,
    "evidence": [ { "charStart": 0, "charEnd": 0, "snippet": "string" } ]
  },
  "headlineClaimStrength": {
    "label": "low|medium|high",
    "confidence": 0.0,
    "evidence": [ { "charStart": 0, "charEnd": 0, "snippet": "string" } ]
  }
}

RULES:
1) Use ONLY labels from the enums above.
2) promiseType is multi-label. Return up to 3 labels. If unsure, return 1 label with lower confidence.
3) Scores must sum to <= 1.0 (do not force to 1).
4) evidence spans MUST reference exact substrings from the title.
   - charStart/charEnd are zero-based indices on the original title string, charEnd exclusive.
   - snippet must equal title[charStart:charEnd].
5) No hallucinations: base decisions only on the title text.
6) If languageHint is "auto", infer language, but do not output language. Just classify.
7) If the title is ambiguous, use:
   - curiosityGapType.label="unknown"
   - headlineClaimStrength="low"
   with low confidence and minimal evidence.

Now wait for the JSON input and respond with ONLY the JSON output.
"""

DESCRIPTION_SYSTEM_PROMPT = """You must output ONLY valid JSON (no markdown, no prose).
Task: Given a YouTube video description and extracted URL spans, classify URL purposes and extract sponsor/affiliate brand mentions and primary CTA. Use only the provided text. No hallucinations.

INPUT JSON payload:
{
  "videoId": "string",
  "title": "string",
  "description": "string",
  "languageHint": "auto|en|es",
  "urls": [
    { "url": "string", "domain": "string", "charStart": 0, "charEnd": 0, "snippet": "string" }
  ]
}

OUTPUT JSON (must match exactly):
{
  "schemaVersion": "llm.description_classifier.v1",
  "videoId": "string",
  "linkPurposes": [
    {
      "url": "string",
      "label": "sponsor|affiliate|sources|social|merch|newsletter|community|other",
      "confidence": 0.0,
      "evidence": [ { "charStart": 0, "charEnd": 0, "snippet": "string" } ]
    }
  ],
  "sponsorBrandMentions": [
    {
      "brand": "string",
      "confidence": 0.0,
      "evidence": [ { "charStart": 0, "charEnd": 0, "snippet": "string" } ]
    }
  ],
  "primaryCTA": {
    "label": "subscribe|like|comment|link|follow|none",
    "confidence": 0.0,
    "evidence": [ { "charStart": 0, "charEnd": 0, "snippet": "string" } ]
  }
}

RULES:
1) Use ONLY labels from the enums.
2) evidence spans MUST reference exact substrings of the original description string.
   - charStart/charEnd are zero-based indices, charEnd exclusive.
   - snippet must equal description[charStart:charEnd].
3) linkPurposes:
   - return an entry for each input url (or at least for the first 10 urls if too many).
   - evidence for a link should point to its URL substring span (use the provided span if correct).
4) sponsorBrandMentions:
   - extract only brands explicitly present in the description text (e.g., "Boot.dev", "NordVPN").
   - if none, return [].
5) primaryCTA:
   - choose the most prominent CTA implied by the description (subscribe/like/comment/link/follow).
   - if no CTA, label "none" with low confidence and empty/short evidence.
6) No free-form explanations. Output JSON only.

Now wait for the JSON input and respond with ONLY the JSON output.
"""

TRANSCRIPT_SYSTEM_PROMPT = """You must output ONLY valid JSON (no markdown, no prose).
Task: From sampled transcript segments and candidate sponsor/CTA segments, classify story arc and extract sponsor/CTA segments with strict evidence.

INPUT JSON payload:
{
  "videoId": "string",
  "title": "string",
  "durationSec": 0,
  "segmentsSample": [
    { "segmentIndex": 0, "startSec": null, "endSec": null, "text": "string" }
  ],
  "candidateSponsorSegments": [
    { "segmentIndex": 0, "startSec": null, "endSec": null, "text": "string" }
  ],
  "candidateCTASegments": [
    { "segmentIndex": 0, "startSec": null, "endSec": null, "text": "string" }
  ]
}

OUTPUT JSON (must match exactly):
{
  "schemaVersion": "llm.transcript_classifier.v1",
  "videoId": "string",
  "storyArc": {
    "label": "problem-solution|listicle|timeline|explainer|debate|investigation|tutorial|other",
    "confidence": 0.0,
    "evidenceSegments": [
      { "segmentIndex": 0, "snippet": "string" }
    ]
  },
  "sponsorSegments": [
    {
      "startSec": null,
      "endSec": null,
      "brand": "string",
      "confidence": 0.0,
      "evidenceSegments": [
        { "segmentIndex": 0, "snippet": "string" }
      ]
    }
  ],
  "ctaSegments": [
    {
      "type": "subscribe|like|comment|link|follow|none",
      "confidence": 0.0,
      "evidenceSegments": [
        { "segmentIndex": 0, "snippet": "string" }
      ]
    }
  ]
}

RULES:
1) Use ONLY labels from the enums.
2) Do NOT hallucinate: base decisions only on provided segmentsSample/candidates.
3) evidenceSegments:
   - segmentIndex MUST exist in segmentsSample (or candidates lists which are subsets of segmentsSample).
   - snippet MUST be an exact substring of that segment's text.
4) sponsorSegments:
   - Only include if sponsorship is explicitly indicated.
   - brand MUST appear literally in the snippet (e.g., "Boot.dev"). If not present, omit the sponsor segment.
   - If no sponsor, return [].
5) ctaSegments:
   - If no CTA is present, return one entry with type "none" with low confidence and minimal evidence (or empty evidenceSegments).
6) Keep outputs concise: max 2 sponsor segments, max 2 cta segments.

Now wait for the JSON input and respond with ONLY the JSON output.
"""

THUMBNAIL_SYSTEM_PROMPT = """You must output ONLY valid JSON (no markdown, no prose).
Task: Given a YouTube thumbnail image (as image input) plus a deterministic summary (OCR text + numeric stats), classify thumbnail archetype and visual signals with strict, auditable outputs.

INPUT JSON payload (text part):
{
  "videoId": "string",
  "title": "string",
  "thumbnail": {
    "width": 0,
    "height": 0,
    "fileSizeBytes": 0
  },
  "ocrSummary": {
    "ocrText": "string",
    "ocrWordCount": 0,
    "textAreaRatio": 0.0,
    "hasBigText": true
  },
  "imageStats": {
    "brightnessMean": 0.0,
    "contrastStd": 0.0,
    "colorfulness": 0.0,
    "sharpnessLaplacianVar": 0.0,
    "edgeDensity": 0.0
  }
}
You will ALSO receive the thumbnail image as an image input in the same message.

OUTPUT JSON (must match exactly):
{
  "schemaVersion": "llm.thumbnail_classifier.v1",
  "videoId": "string",
  "archetype": {
    "label": "reaction|diagram|logo|portrait|screenshot|text-heavy|collage|other",
    "confidence": 0.0,
    "evidenceSignals": [
      { "field": "string", "value": "string" }
    ],
    "evidenceRegions": [
      { "label": "face|text|logo|ui|diagram", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 }
    ]
  },
  "faceSignals": {
    "faceCountBucket": "0|1|2|3plus",
    "dominantFacePosition": { "x": "left|center|right|unknown", "y": "top|mid|bottom|unknown" },
    "faceEmotionTone": "positive|negative|neutral|mixed|unknown",
    "hasEyeContact": "true|false|unknown",
    "confidence": 0.0,
    "evidenceRegions": [
      { "label": "face", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 }
    ]
  },
  "clutterLevel": {
    "label": "low|medium|high",
    "confidence": 0.0,
    "evidenceSignals": [
      { "field": "string", "value": "string" }
    ]
  },
  "styleTags": [
    { "label": "high-contrast|low-contrast|colorful|dark|minimal|cluttered|clean|big-text|no-text|face|no-face|logo-heavy|screenshot-like|diagram-like", "confidence": 0.0 }
  ]
}

RULES:
1) Use ONLY labels from the enums above.
2) Do NOT hallucinate facts not visible in the image or provided summary.
3) evidenceRegions:
   - All coordinates are normalized in [0,1].
   - If uncertain, you may omit regions or provide fewer regions.
4) faceSignals:
   - If faceCountBucket is "0", set dominantFacePosition.x/y to "unknown" and hasEyeContact to "unknown". Provide empty evidenceRegions or omit them.
5) styleTags:
   - Return up to 6 tags. Each with confidence.
6) evidenceSignals:
   - Reference the deterministic fields when relevant (e.g., "textAreaRatio", "edgeDensity", "ocrWordCount").
7) If unsure, choose conservative outputs:
   - archetype.label = "other"
   - faceCountBucket = "0"
   - clutterLevel = "medium"
   - low confidences.

Return JSON only.
"""

CHANNEL_ORCHESTRATOR_SYSTEM_PROMPT = """You must output ONLY valid JSON (no markdown, no prose).
Task: Given a deterministic summary of a YouTube channel export (cohorts, drivers, exemplars with numeric evidence), produce an analysis playbook and reusable templates for a new channel strategy. Do not compute new stats. Do not hallucinate.

INPUT JSON payload shape (high-level):
{
  "schemaVersion": "analysis.orchestrator_input.v1",
  "channel": { "channelId": "...", "channelName": "...", "timeframe": "1m|6m|1y" },
  "rows": [
    {
      "videoId": "...",
      "title": "...",
      "publishedAt": "...",
      "performance": { "viewsPerDay": 0.0, "engagementRate": 0.0, "residual": 0.0, "percentile": 0.0 },
      "features": {
        "...": "flattened key/value signals (numbers, enums, booleans) ..."
      }
    }
  ],
  "cohorts": [
    {
      "key": { "duration_bucket": "...", "promise_type_primary": "...", "thumbnail_archetype": "..." },
      "n": 0,
      "metrics": { "median_residual": 0.0, "median_viewsPerDay": 0.0, "median_engagementRate": 0.0 },
      "exemplars": [ { "videoId":"...", "percentile":0.0 } ]
    }
  ],
  "drivers": [
    {
      "feature": "string",
      "type": "spearman|delta",
      "effect": 0.0,
      "n": 0,
      "supported_by": ["videoId1","videoId2"],
      "evidence_fields": ["performance.residual", "features.thumbnail.textAreaRatio"]
    }
  ],
  "exemplars": {
    "top": [ { "videoId":"...", "percentile":0.0 } ],
    "bottom": [ { "videoId":"...", "percentile":0.0 } ],
    "baseline": [ { "videoId":"...", "percentile":0.0 } ]
  },
  "warnings": ["..."]
}

OUTPUT JSON (must match exactly):
{
  "schemaVersion": "llm.channel_orchestrator.v1",
  "channelId": "string",
  "playbook": {
    "schemaVersion": "analysis.playbook.v1",
    "positioning": {
      "oneLine": "string",
      "audience": ["string"],
      "valueProps": ["string"]
    },
    "contentPillars": [
      {
        "pillar": "string",
        "description": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["string"]
      }
    ],
    "insights": [
      {
        "id": "string",
        "statement": "string",
        "confidence": 0.0,
        "supported_by": ["videoId"],
        "evidence_fields": ["string"]
      }
    ],
    "antiPatterns": [
      {
        "statement": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["string"]
      }
    ],
    "checklists": {
      "title": ["string"],
      "thumbnail": ["string"],
      "hook_0_30s": ["string"]
    }
  },
  "templates": {
    "schemaVersion": "derived.templates.v1",
    "title": {
      "rules": [
        {
          "rule": "string",
          "supported_by": ["videoId"],
          "evidence_fields": ["string"]
        }
      ],
      "formulas": [
        {
          "pattern": "string",
          "examples": ["string"],
          "supported_by": ["videoId"],
          "evidence_fields": ["string"]
        }
      ]
    },
    "thumbnail": {
      "rules": [
        {
          "rule": "string",
          "supported_by": ["videoId"],
          "evidence_fields": ["string"]
        }
      ],
      "archetypes": [
        {
          "label": "string",
          "designBrief": "string",
          "supported_by": ["videoId"],
          "evidence_fields": ["string"]
        }
      ]
    },
    "script": {
      "blueprints": [
        {
          "label": "string",
          "timeline": [
            { "rangeSec": "0-10", "instruction": "string" },
            { "rangeSec": "10-30", "instruction": "string" },
            { "rangeSec": "30-120", "instruction": "string" },
            { "rangeSec": "mid", "instruction": "string" },
            { "rangeSec": "end", "instruction": "string" }
          ],
          "supported_by": ["videoId"],
          "evidence_fields": ["string"]
        }
      ]
    }
  }
}

RULES:
1) Use ONLY the provided deterministic input. Do NOT compute new stats.
2) Every insight/rule/formula/archetype/blueprint MUST include:
   - supported_by: videoIds that exist in the input rows
   - evidence_fields: dot-separated field paths that exist inside each video row object
     (e.g. "performance.residual", "features.thumbnail.textAreaRatio", "performance.percentile").
     Do NOT use top-level input keys like "drivers", "cohorts", or "exemplars".
     Do NOT use array bracket notation like "drivers[].feature".
     Only reference paths within the "rows[*]" objects.
3) Keep statements concise and operational (actionable).
4) If evidence is weak (low n), lower confidence and avoid strong claims.
5) Do not invent CTR/retention/impressions or any YouTube Analytics-only metrics.
6) Prefer using "drivers" and "cohorts" as the basis for insights.
7) Output JSON only.
"""

PROMISE_LABELS = {
    "howto/tutorial",
    "review",
    "news",
    "challenge",
    "comparison",
    "listicle",
    "storytime",
    "reaction",
    "case-study",
    "tooling",
    "explainer",
}

CURIOSITY_LABELS = {
    "threat",
    "mystery",
    "contrarian",
    "how-to",
    "controversy",
    "warning",
    "breakdown",
    "unknown",
}

CLAIM_STRENGTH_LABELS = {"low", "medium", "high"}
LINK_PURPOSE_LABELS = {
    "sponsor",
    "affiliate",
    "sources",
    "social",
    "merch",
    "newsletter",
    "community",
    "other",
}
PRIMARY_CTA_LABELS = {"subscribe", "like", "comment", "link", "follow", "none"}
STORY_ARC_LABELS = {
    "problem-solution",
    "listicle",
    "timeline",
    "explainer",
    "debate",
    "investigation",
    "tutorial",
    "other",
}
TRANSCRIPT_CTA_LABELS = {"subscribe", "like", "comment", "link", "follow", "none"}
THUMB_ARCHETYPE_LABELS = {
    "reaction",
    "diagram",
    "logo",
    "portrait",
    "screenshot",
    "text-heavy",
    "collage",
    "other",
}
THUMB_FACE_COUNT_BUCKETS = {"0", "1", "2", "3plus"}
THUMB_FACE_POSITION_X = {"left", "center", "right", "unknown"}
THUMB_FACE_POSITION_Y = {"top", "mid", "bottom", "unknown"}
THUMB_FACE_EMOTION_TONES = {"positive", "negative", "neutral", "mixed", "unknown"}
THUMB_CLUTTER_LEVELS = {"low", "medium", "high"}
THUMB_STYLE_TAGS = {
    "high-contrast",
    "low-contrast",
    "colorful",
    "dark",
    "minimal",
    "cluttered",
    "clean",
    "big-text",
    "no-text",
    "face",
    "no-face",
    "logo-heavy",
    "screenshot-like",
    "diagram-like",
}

MODEL_ALIASES = {
    # Keep canonical chat model names for API routing.
    "gpt-5.2": "gpt-5.2",
    "gpt-5.2-pro": "gpt-5.2-pro",
    # Backward compatibility for previously pinned snapshots.
    "gpt-5.2-2025-12-11": "gpt-5.2",
    "gpt-5.2-pro-2025-12-11": "gpt-5.2-pro",
}

GPT_5_2_MODEL_INFO: Dict[str, Any] = {
    "vision": True,
    "function_calling": True,
    "json_output": True,
    "family": "gpt-5",
    "structured_output": True,
    "multiple_system_messages": True,
}

RESPONSES_ONLY_MODELS: set[str] = {
    "gpt-5.2-pro",
    "gpt-5.2-pro-2025-12-11",
}


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def ensure_autogen_available() -> None:
    if AUTOGEN_IMPORT_ERROR is None:
        return

    requirements_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements-autogen.txt")
    python_bin = sys.executable or "python"
    raise RuntimeError(
        "AutoGen python dependencies are missing. "
        f"Install them with: {python_bin} -m pip install -r {requirements_path}. "
        f"Original import error: {AUTOGEN_IMPORT_ERROR}"
    )


def clamp_01(value: Any) -> float:
    if not isinstance(value, (float, int)):
        return 0.0
    if value <= 0:
        return 0.0
    if value >= 1:
        return 1.0
    return round(float(value), 6)


def normalize_evidence(raw: Any, source_text: str) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    normalized: List[Dict[str, Any]] = []
    source_len = len(source_text)
    for item in raw:
        if not isinstance(item, dict):
            continue

        start = item.get("charStart", 0)
        end = item.get("charEnd", 0)
        snippet = item.get("snippet", "")

        if not isinstance(start, int):
            start = 0
        if not isinstance(end, int):
            end = start

        start = max(0, min(start, source_len))
        end = max(start, min(end, source_len))

        if not isinstance(snippet, str) or not snippet.strip():
            snippet = source_text[start:end]

        normalized.append({"charStart": start, "charEnd": end, "snippet": snippet})

    return normalized


def normalize_single_evidence(raw: Any, source_text: str) -> Dict[str, Any]:
    normalized = normalize_evidence([raw], source_text)
    if normalized:
        return normalized[0]
    return {"charStart": 0, "charEnd": 0, "snippet": ""}


def normalize_multi_label(raw: Any, title: str, allowed_labels: set[str]) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue

        label = item.get("label")
        if not isinstance(label, str) or label not in allowed_labels:
            continue

        normalized.append(
            {
                "label": label,
                "score": clamp_01(item.get("score", 0.0)),
                "confidence": clamp_01(item.get("confidence", 0.0)),
                "evidence": normalize_evidence(item.get("evidence", []), title),
            }
        )

    normalized.sort(key=lambda x: x.get("score", 0), reverse=True)
    return normalized


def normalize_claim_strength(raw: Any, title: str) -> Dict[str, Any] | None:
    if raw is None or not isinstance(raw, dict):
        return None

    label = raw.get("label")
    if not isinstance(label, str) or label not in CLAIM_STRENGTH_LABELS:
        return None

    return {
        "label": label,
        "confidence": clamp_01(raw.get("confidence", 0.0)),
        "evidence": normalize_evidence(raw.get("evidence", []), title),
    }


def coerce_title_result(raw: Any, title: str) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    raw_promise_type = source.get("promiseType")
    if not isinstance(raw_promise_type, list):
        raw_promise_type = source.get("promise_type", [])

    curiosity_items: List[Dict[str, Any]] = []
    raw_curiosity = source.get("curiosityGapType")
    if isinstance(raw_curiosity, dict):
        label = raw_curiosity.get("label")
        if isinstance(label, str) and label in CURIOSITY_LABELS:
            confidence = clamp_01(raw_curiosity.get("confidence", 0.0))
            curiosity_items.append(
                {
                    "label": label,
                    "score": confidence,
                    "confidence": confidence,
                    "evidence": normalize_evidence(raw_curiosity.get("evidence", []), title),
                }
            )
    elif isinstance(source.get("curiosity_gap_type"), list):
        curiosity_items = normalize_multi_label(source.get("curiosity_gap_type", []), title, CURIOSITY_LABELS)

    raw_headline = source.get("headlineClaimStrength")
    if not isinstance(raw_headline, dict):
        raw_headline = source.get("headline_claim_strength")

    return {
        "schemaVersion": "derived.title_llm.v1",
        "promise_type": normalize_multi_label(raw_promise_type, title, PROMISE_LABELS),
        "curiosity_gap_type": curiosity_items,
        "headline_claim_strength": normalize_claim_strength(raw_headline, title),
    }


def coerce_description_result(raw: Any, description: str) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}

    link_purpose: List[Dict[str, Any]] = []
    raw_link_purposes = source.get("linkPurposes")
    if not isinstance(raw_link_purposes, list):
        raw_link_purposes = source.get("linkPurpose")
    if isinstance(raw_link_purposes, list):
        for item in raw_link_purposes:
            if not isinstance(item, dict):
                continue

            url = item.get("url")
            label = item.get("label")
            if not isinstance(url, str) or not url.strip():
                continue
            if not isinstance(label, str) or label not in LINK_PURPOSE_LABELS:
                continue
            raw_evidence = item.get("evidence")
            if isinstance(raw_evidence, list):
                normalized_evidence = normalize_evidence(raw_evidence, description)
                normalized_single_evidence = (
                    normalized_evidence[0]
                    if normalized_evidence
                    else {"charStart": 0, "charEnd": 0, "snippet": ""}
                )
            else:
                normalized_single_evidence = normalize_single_evidence(raw_evidence, description)
            link_purpose.append(
                {
                    "url": url.strip(),
                    "label": label,
                    "confidence": clamp_01(item.get("confidence", 0.0)),
                    "evidence": normalized_single_evidence,
                }
            )

    sponsor_brand_mentions: List[Dict[str, Any]] = []
    if isinstance(source.get("sponsorBrandMentions"), list):
        for item in source.get("sponsorBrandMentions", []):
            if not isinstance(item, dict):
                continue

            brand = item.get("brand")
            if not isinstance(brand, str) or not brand.strip():
                continue

            sponsor_brand_mentions.append(
                {
                    "brand": brand.strip(),
                    "confidence": clamp_01(item.get("confidence", 0.0)),
                    "evidence": normalize_evidence(item.get("evidence", []), description),
                }
            )

    primary_cta = None
    raw_primary = source.get("primaryCTA")
    if isinstance(raw_primary, dict):
        label = raw_primary.get("label")
        if isinstance(label, str) and label in PRIMARY_CTA_LABELS:
            primary_cta = {
                "label": label,
                "confidence": clamp_01(raw_primary.get("confidence", 0.0)),
                "evidence": normalize_evidence(raw_primary.get("evidence", []), description),
            }

    return {
        "schemaVersion": "derived.description_llm.v1",
        "linkPurpose": link_purpose,
        "sponsorBrandMentions": sponsor_brand_mentions,
        "primaryCTA": primary_cta,
    }


def normalize_transcript_evidence(raw: Any, sample_segments: Dict[int, str]) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue

        segment_index = item.get("segmentIndex")
        snippet = item.get("snippet")
        if not isinstance(segment_index, int):
            continue
        if not isinstance(snippet, str) or not snippet.strip():
            continue

        segment_text = sample_segments.get(segment_index, "")
        if not segment_text or snippet not in segment_text:
            continue

        normalized.append({"segmentIndex": segment_index, "snippet": snippet})

    return normalized


def coerce_transcript_result(raw: Any, sample_segments: Dict[int, str]) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}

    story_arc = None
    story_arc_raw = source.get("storyArc")
    if not isinstance(story_arc_raw, dict):
        story_arc_raw = source.get("story_arc")
    if isinstance(story_arc_raw, dict):
        story_label = story_arc_raw.get("label")
        if isinstance(story_label, str) and story_label in STORY_ARC_LABELS:
            story_arc = {
                "label": story_label,
                "confidence": clamp_01(story_arc_raw.get("confidence", 0.0)),
                "evidenceSegments": normalize_transcript_evidence(
                    story_arc_raw.get("evidenceSegments", []), sample_segments
                ),
            }

    sponsor_segments: List[Dict[str, Any]] = []
    raw_sponsor_segments = source.get("sponsorSegments")
    if not isinstance(raw_sponsor_segments, list):
        raw_sponsor_segments = source.get("sponsor_segments")
    if isinstance(raw_sponsor_segments, list):
        for item in raw_sponsor_segments:
            if not isinstance(item, dict):
                continue

            brand = item.get("brand")
            if not isinstance(brand, str) or not brand.strip():
                continue

            evidence_segments = normalize_transcript_evidence(item.get("evidenceSegments", []), sample_segments)
            if not evidence_segments:
                continue

            brand_lower = brand.lower().strip()
            if not any(brand_lower in evidence.get("snippet", "").lower() for evidence in evidence_segments):
                continue

            start_sec = item.get("startSec")
            end_sec = item.get("endSec")
            sponsor_segments.append(
                {
                    "startSec": float(start_sec) if isinstance(start_sec, (int, float)) else None,
                    "endSec": float(end_sec) if isinstance(end_sec, (int, float)) else None,
                    "brand": brand.strip(),
                    "confidence": clamp_01(item.get("confidence", 0.0)),
                    "evidenceSegments": evidence_segments,
                }
            )
            if len(sponsor_segments) >= 2:
                break

    cta_segments: List[Dict[str, Any]] = []
    raw_cta_segments = source.get("ctaSegments")
    if not isinstance(raw_cta_segments, list):
        raw_cta_segments = source.get("cta_segments")
    if isinstance(raw_cta_segments, list):
        for item in raw_cta_segments:
            if not isinstance(item, dict):
                continue

            cta_type = item.get("type")
            if not isinstance(cta_type, str) or cta_type not in TRANSCRIPT_CTA_LABELS:
                continue

            cta_segments.append(
                {
                    "type": cta_type,
                    "confidence": clamp_01(item.get("confidence", 0.0)),
                    "evidenceSegments": normalize_transcript_evidence(
                        item.get("evidenceSegments", []), sample_segments
                    ),
                }
            )
            if len(cta_segments) >= 2:
                break

    return {
        "schemaVersion": "derived.transcript_llm.v1",
        "story_arc": story_arc,
        "sponsor_segments": sponsor_segments,
        "cta_segments": cta_segments,
    }


def clamp_bbox(value: Any) -> float:
    if not isinstance(value, (int, float)):
        return 0.0
    if value <= 0:
        return 0.0
    if value >= 1:
        return 1.0
    return round(float(value), 6)


def coerce_thumbnail_result(raw: Any) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}

    archetype_raw = source.get("archetype")
    archetype_label = "other"
    archetype_confidence = 0.0
    if isinstance(archetype_raw, dict):
        label = archetype_raw.get("label")
        if isinstance(label, str) and label in THUMB_ARCHETYPE_LABELS:
            archetype_label = label
        archetype_confidence = clamp_01(archetype_raw.get("confidence", 0.0))

    face_raw = source.get("faceSignals")
    face_count_bucket = "0"
    dominant_face_position = {"x": "unknown", "y": "unknown"}
    face_emotion_tone = "unknown"
    has_eye_contact: bool | str = "unknown"
    face_confidence = 0.0

    if isinstance(face_raw, dict):
        bucket = face_raw.get("faceCountBucket")
        if isinstance(bucket, str) and bucket in THUMB_FACE_COUNT_BUCKETS:
            face_count_bucket = bucket

        pos_raw = face_raw.get("dominantFacePosition")
        if isinstance(pos_raw, dict):
            x = pos_raw.get("x")
            y = pos_raw.get("y")
            if isinstance(x, str) and x in THUMB_FACE_POSITION_X:
                dominant_face_position["x"] = x
            if isinstance(y, str) and y in THUMB_FACE_POSITION_Y:
                dominant_face_position["y"] = y

        tone = face_raw.get("faceEmotionTone")
        if isinstance(tone, str) and tone in THUMB_FACE_EMOTION_TONES:
            face_emotion_tone = tone

        eye_contact = face_raw.get("hasEyeContact")
        if eye_contact is True or eye_contact is False:
            has_eye_contact = eye_contact
        elif eye_contact == "unknown":
            has_eye_contact = "unknown"
        elif eye_contact == "true":
            has_eye_contact = True
        elif eye_contact == "false":
            has_eye_contact = False

        face_confidence = clamp_01(face_raw.get("confidence", 0.0))

    if face_count_bucket == "0":
        dominant_face_position = {"x": "unknown", "y": "unknown"}
        has_eye_contact = "unknown"

    clutter_raw = source.get("clutterLevel")
    clutter_label = "medium"
    clutter_confidence = 0.0
    if isinstance(clutter_raw, dict):
        label = clutter_raw.get("label")
        if isinstance(label, str) and label in THUMB_CLUTTER_LEVELS:
            clutter_label = label
        clutter_confidence = clamp_01(clutter_raw.get("confidence", 0.0))

    style_tags: List[Dict[str, Any]] = []
    seen_tags = set()
    raw_tags = source.get("styleTags")
    if isinstance(raw_tags, list):
        for item in raw_tags:
            if not isinstance(item, dict):
                continue
            label = item.get("label")
            if not isinstance(label, str) or label not in THUMB_STYLE_TAGS:
                continue
            if label in seen_tags:
                continue
            seen_tags.add(label)
            style_tags.append({"label": label, "confidence": clamp_01(item.get("confidence", 0.0))})
            if len(style_tags) >= 6:
                break

    if face_count_bucket == "0":
        style_tags = [tag for tag in style_tags if tag.get("label") != "face"]

    evidence_regions: List[Dict[str, Any]] = []
    raw_top_regions = source.get("evidenceRegions")
    if isinstance(raw_top_regions, list):
        for item in raw_top_regions:
            if not isinstance(item, dict):
                continue
            label = item.get("label")
            evidence_regions.append(
                {
                    "label": str(label).strip() if isinstance(label, str) and label.strip() else "region",
                    "x": clamp_bbox(item.get("x", 0.0)),
                    "y": clamp_bbox(item.get("y", 0.0)),
                    "w": clamp_bbox(item.get("w", 0.0)),
                    "h": clamp_bbox(item.get("h", 0.0)),
                }
            )
    if isinstance(archetype_raw, dict) and isinstance(archetype_raw.get("evidenceRegions"), list):
        for item in archetype_raw.get("evidenceRegions", []):
            if not isinstance(item, dict):
                continue
            label = item.get("label")
            evidence_regions.append(
                {
                    "label": str(label).strip() if isinstance(label, str) and label.strip() else "region",
                    "x": clamp_bbox(item.get("x", 0.0)),
                    "y": clamp_bbox(item.get("y", 0.0)),
                    "w": clamp_bbox(item.get("w", 0.0)),
                    "h": clamp_bbox(item.get("h", 0.0)),
                }
            )
    if isinstance(face_raw, dict) and isinstance(face_raw.get("evidenceRegions"), list):
        for item in face_raw.get("evidenceRegions", []):
            if not isinstance(item, dict):
                continue
            label = item.get("label")
            evidence_regions.append(
                {
                    "label": str(label).strip() if isinstance(label, str) and label.strip() else "region",
                    "x": clamp_bbox(item.get("x", 0.0)),
                    "y": clamp_bbox(item.get("y", 0.0)),
                    "w": clamp_bbox(item.get("w", 0.0)),
                    "h": clamp_bbox(item.get("h", 0.0)),
                }
            )

    evidence_signals: List[Dict[str, Any]] = []
    raw_top_signals = source.get("evidenceSignals")
    if isinstance(raw_top_signals, list):
        for item in raw_top_signals:
            if not isinstance(item, dict):
                continue
            field_name = item.get("fieldName")
            if not isinstance(field_name, str) or not field_name.strip():
                continue
            value = item.get("value")
            if isinstance(value, (float, int)):
                value = round(float(value), 6)
            elif not isinstance(value, (str, bool)) and value is not None:
                value = None
            evidence_signals.append({"fieldName": field_name.strip(), "value": value})
    for signal_container in (archetype_raw, clutter_raw):
        if not isinstance(signal_container, dict):
            continue
        raw_signals = signal_container.get("evidenceSignals")
        if not isinstance(raw_signals, list):
            continue
        for item in raw_signals:
            if not isinstance(item, dict):
                continue
            field_name = item.get("field")
            if not isinstance(field_name, str) or not field_name.strip():
                field_name = item.get("fieldName")
            if not isinstance(field_name, str) or not field_name.strip():
                continue
            value = item.get("value")
            if isinstance(value, (float, int)):
                value = round(float(value), 6)
            elif not isinstance(value, (str, bool)) and value is not None:
                value = None
            evidence_signals.append({"fieldName": field_name.strip(), "value": value})

    return {
        "schemaVersion": "derived.thumbnail_llm.v1",
        "archetype": {"label": archetype_label, "confidence": archetype_confidence},
        "faceSignals": {
            "faceCountBucket": face_count_bucket,
            "dominantFacePosition": dominant_face_position,
            "faceEmotionTone": face_emotion_tone,
            "hasEyeContact": has_eye_contact,
            "confidence": face_confidence,
        },
        "clutterLevel": {"label": clutter_label, "confidence": clutter_confidence},
        "styleTags": style_tags,
        "evidenceRegions": evidence_regions,
        "evidenceSignals": evidence_signals,
    }


def _normalize_supported_by(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    normalized: List[str] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            normalized.append(item.strip())
    return normalized


def _normalize_evidence_fields(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    normalized: List[str] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            normalized.append(item.strip())
    return normalized


def _normalize_claim_list(raw: Any, default_prefix: str) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        claim_id = item.get("id")
        title = item.get("title")
        summary = item.get("summary")
        template = item.get("template")
        name = item.get("name")
        recommendation = item.get("recommendation")
        label = item.get("label")
        rationale = item.get("rationale")
        when_to_use = item.get("when_to_use")
        normalized_item: Dict[str, Any] = {
            "id": str(claim_id).strip() if isinstance(claim_id, str) and claim_id.strip() else f"{default_prefix}-{index + 1}",
            "supported_by": _normalize_supported_by(item.get("supported_by")),
            "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
        }
        if isinstance(title, str) and title.strip():
            normalized_item["title"] = title.strip()
        if isinstance(summary, str) and summary.strip():
            normalized_item["summary"] = summary.strip()
        if isinstance(template, str) and template.strip():
            normalized_item["template"] = template.strip()
        if isinstance(name, str) and name.strip():
            normalized_item["name"] = name.strip()
        if isinstance(recommendation, str) and recommendation.strip():
            normalized_item["recommendation"] = recommendation.strip()
        if isinstance(label, str) and label.strip():
            normalized_item["label"] = label.strip()
        if isinstance(rationale, str) and rationale.strip():
            normalized_item["rationale"] = rationale.strip()
        if isinstance(when_to_use, str) and when_to_use.strip():
            normalized_item["when_to_use"] = when_to_use.strip()
        normalized.append(normalized_item)
    return normalized


def coerce_channel_orchestrator_result(raw: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    playbook_raw = source.get("playbook")
    templates_raw = source.get("templates")

    channel_input = payload.get("channel")
    channel_fallback = channel_input if isinstance(channel_input, dict) else {}
    generated_at = str(source.get("generatedAt", "")) if isinstance(source.get("generatedAt"), str) else ""
    if not generated_at:
        generated_at = payload.get("generatedAt") if isinstance(payload.get("generatedAt"), str) else ""
    if not generated_at:
        generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    playbook_source = playbook_raw if isinstance(playbook_raw, dict) else {}
    templates_source = templates_raw if isinstance(templates_raw, dict) else {}

    playbook_warnings: List[str] = []
    if isinstance(payload.get("warnings"), list):
        playbook_warnings.extend([str(item) for item in payload.get("warnings", []) if isinstance(item, str)])
    if isinstance(source.get("warnings"), list):
        playbook_warnings.extend([str(item) for item in source.get("warnings", []) if isinstance(item, str)])
    if isinstance(playbook_source.get("warnings"), list):
        playbook_warnings.extend([str(item) for item in playbook_source.get("warnings", []) if isinstance(item, str)])

    templates_warnings: List[str] = []
    if isinstance(source.get("warnings"), list):
        templates_warnings.extend([str(item) for item in source.get("warnings", []) if isinstance(item, str)])
    if isinstance(templates_source.get("warnings"), list):
        templates_warnings.extend([str(item) for item in templates_source.get("warnings", []) if isinstance(item, str)])

    playbook_uses_new_shape = isinstance(playbook_source.get("positioning"), dict) or isinstance(
        playbook_source.get("contentPillars"), list
    )
    templates_use_new_shape = isinstance(templates_source.get("title"), dict) or isinstance(
        templates_source.get("thumbnail"), dict
    )

    if playbook_uses_new_shape:
        normalized_insights: List[Dict[str, Any]] = []
        raw_insights = playbook_source.get("insights")
        if isinstance(raw_insights, list):
            for index, item in enumerate(raw_insights):
                if not isinstance(item, dict):
                    continue
                statement = item.get("statement")
                confidence = clamp_01(item.get("confidence", 0.0))
                summary = statement.strip() if isinstance(statement, str) else ""
                if confidence > 0:
                    summary = f"{summary} (confidence={confidence})" if summary else f"confidence={confidence}"
                normalized_insights.append(
                    {
                        "id": str(item.get("id")).strip()
                        if isinstance(item.get("id"), str) and str(item.get("id")).strip()
                        else f"insight-{index + 1}",
                        "title": summary if summary else f"Insight {index + 1}",
                        "summary": summary,
                        "supported_by": _normalize_supported_by(item.get("supported_by")),
                        "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                    }
                )

        normalized_rules: List[Dict[str, Any]] = []
        raw_pillars = playbook_source.get("contentPillars")
        if isinstance(raw_pillars, list):
            for index, item in enumerate(raw_pillars):
                if not isinstance(item, dict):
                    continue
                pillar = item.get("pillar")
                description = item.get("description")
                normalized_rules.append(
                    {
                        "id": f"pillar-{index + 1}",
                        "name": pillar.strip() if isinstance(pillar, str) and pillar.strip() else f"Pillar {index + 1}",
                        "recommendation": description.strip() if isinstance(description, str) else "",
                        "supported_by": _normalize_supported_by(item.get("supported_by")),
                        "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                    }
                )

        normalized_keys: List[Dict[str, Any]] = []
        raw_anti_patterns = playbook_source.get("antiPatterns")
        if isinstance(raw_anti_patterns, list):
            for index, item in enumerate(raw_anti_patterns):
                if not isinstance(item, dict):
                    continue
                statement = item.get("statement")
                normalized_keys.append(
                    {
                        "id": f"anti-pattern-{index + 1}",
                        "label": "anti-pattern",
                        "rationale": statement.strip() if isinstance(statement, str) else "",
                        "supported_by": _normalize_supported_by(item.get("supported_by")),
                        "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                    }
                )

        playbook = {
            "schemaVersion": "analysis.playbook.v1",
            "generatedAt": generated_at,
            "channel": channel_fallback,
            "warnings": list(dict.fromkeys(playbook_warnings)),
            "insights": normalized_insights,
            "rules": normalized_rules,
            "keys": normalized_keys,
            "evidence": {
                "cohorts": payload.get("cohorts") if isinstance(payload.get("cohorts"), list) else [],
                "drivers": payload.get("drivers") if isinstance(payload.get("drivers"), list) else [],
                "exemplars": payload.get("exemplars") if isinstance(payload.get("exemplars"), dict) else {},
            },
        }
    else:
        playbook = {
            "schemaVersion": "analysis.playbook.v1",
            "generatedAt": str(playbook_source.get("generatedAt", generated_at)),
            "channel": playbook_source.get("channel")
            if isinstance(playbook_source.get("channel"), dict)
            else channel_fallback,
            "warnings": list(dict.fromkeys(playbook_warnings)),
            "insights": _normalize_claim_list(playbook_source.get("insights"), "insight"),
            "rules": _normalize_claim_list(playbook_source.get("rules"), "rule"),
            "keys": _normalize_claim_list(playbook_source.get("keys"), "key"),
            "evidence": playbook_source.get("evidence") if isinstance(playbook_source.get("evidence"), dict) else {},
        }

    if templates_use_new_shape:
        title_templates: List[Dict[str, Any]] = []
        title_source = templates_source.get("title")
        if isinstance(title_source, dict):
            raw_rules = title_source.get("rules")
            if isinstance(raw_rules, list):
                for index, item in enumerate(raw_rules):
                    if not isinstance(item, dict):
                        continue
                    rule = item.get("rule")
                    title_templates.append(
                        {
                            "id": f"title-rule-{index + 1}",
                            "template": rule.strip() if isinstance(rule, str) else "",
                            "when_to_use": "Apply when evidence indicates this title pattern",
                            "supported_by": _normalize_supported_by(item.get("supported_by")),
                            "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                        }
                    )
            raw_formulas = title_source.get("formulas")
            if isinstance(raw_formulas, list):
                base_index = len(title_templates)
                for index, item in enumerate(raw_formulas):
                    if not isinstance(item, dict):
                        continue
                    pattern = item.get("pattern")
                    examples = item.get("examples")
                    when_to_use = ""
                    if isinstance(examples, list):
                        examples_text = [str(example).strip() for example in examples if isinstance(example, str) and str(example).strip()]
                        if examples_text:
                            when_to_use = "Examples: " + " | ".join(examples_text[:3])
                    title_templates.append(
                        {
                            "id": f"title-formula-{base_index + index + 1}",
                            "template": pattern.strip() if isinstance(pattern, str) else "",
                            "when_to_use": when_to_use,
                            "supported_by": _normalize_supported_by(item.get("supported_by")),
                            "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                        }
                    )

        thumbnail_templates: List[Dict[str, Any]] = []
        thumbnail_source = templates_source.get("thumbnail")
        if isinstance(thumbnail_source, dict):
            raw_rules = thumbnail_source.get("rules")
            if isinstance(raw_rules, list):
                for index, item in enumerate(raw_rules):
                    if not isinstance(item, dict):
                        continue
                    rule = item.get("rule")
                    thumbnail_templates.append(
                        {
                            "id": f"thumbnail-rule-{index + 1}",
                            "template": rule.strip() if isinstance(rule, str) else "",
                            "when_to_use": "Use when corresponding thumbnail evidence is present",
                            "supported_by": _normalize_supported_by(item.get("supported_by")),
                            "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                        }
                    )
            raw_archetypes = thumbnail_source.get("archetypes")
            if isinstance(raw_archetypes, list):
                base_index = len(thumbnail_templates)
                for index, item in enumerate(raw_archetypes):
                    if not isinstance(item, dict):
                        continue
                    label = item.get("label")
                    design_brief = item.get("designBrief")
                    thumbnail_templates.append(
                        {
                            "id": f"thumbnail-archetype-{base_index + index + 1}",
                            "template": design_brief.strip() if isinstance(design_brief, str) else "",
                            "when_to_use": label.strip() if isinstance(label, str) else "",
                            "supported_by": _normalize_supported_by(item.get("supported_by")),
                            "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                        }
                    )

        script_templates: List[Dict[str, Any]] = []
        script_source = templates_source.get("script")
        if isinstance(script_source, dict):
            raw_blueprints = script_source.get("blueprints")
            if isinstance(raw_blueprints, list):
                for index, item in enumerate(raw_blueprints):
                    if not isinstance(item, dict):
                        continue
                    label = item.get("label")
                    timeline = item.get("timeline")
                    timeline_steps: List[str] = []
                    if isinstance(timeline, list):
                        for step in timeline:
                            if not isinstance(step, dict):
                                continue
                            step_range = step.get("rangeSec")
                            instruction = step.get("instruction")
                            if isinstance(step_range, str) and isinstance(instruction, str):
                                timeline_steps.append(f"{step_range}: {instruction.strip()}")
                    script_templates.append(
                        {
                            "id": f"script-blueprint-{index + 1}",
                            "template": " | ".join(timeline_steps),
                            "when_to_use": label.strip() if isinstance(label, str) else "",
                            "supported_by": _normalize_supported_by(item.get("supported_by")),
                            "evidence_fields": _normalize_evidence_fields(item.get("evidence_fields")),
                        }
                    )

        templates = {
            "schemaVersion": "derived.templates.v1",
            "generatedAt": generated_at,
            "channel": channel_fallback,
            "warnings": list(dict.fromkeys(templates_warnings)),
            "titleTemplates": title_templates,
            "thumbnailTemplates": thumbnail_templates,
            "scriptTemplates": script_templates,
        }
    else:
        templates = {
            "schemaVersion": "derived.templates.v1",
            "generatedAt": str(templates_source.get("generatedAt", generated_at)),
            "channel": templates_source.get("channel")
            if isinstance(templates_source.get("channel"), dict)
            else channel_fallback,
            "warnings": list(dict.fromkeys(templates_warnings)),
            "titleTemplates": _normalize_claim_list(templates_source.get("titleTemplates"), "title-template"),
            "thumbnailTemplates": _normalize_claim_list(templates_source.get("thumbnailTemplates"), "thumbnail-template"),
            "scriptTemplates": _normalize_claim_list(templates_source.get("scriptTemplates"), "script-template"),
        }

    return {
        "playbook": playbook,
        "templates": templates,
    }


def extract_text_from_agent_result(run_result: Any) -> str:
    if isinstance(run_result, str):
        return run_result

    chat_message = getattr(run_result, "chat_message", None)
    if chat_message is not None:
        content = getattr(chat_message, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts: List[str] = []
            for part in content:
                if isinstance(part, str):
                    text_parts.append(part)
                elif isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        text_parts.append(text)
            if text_parts:
                return "\n".join(text_parts)

    messages = getattr(run_result, "messages", None)
    if isinstance(messages, list) and messages:
        last_message = messages[-1]
        content = getattr(last_message, "content", None)
        if isinstance(content, str):
            return content

    content = getattr(run_result, "content", None)
    if isinstance(content, str):
        return content

    return ""


def parse_agent_json(content: str) -> Any:
    stripped = content.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.lower().startswith("json"):
            stripped = stripped[4:].strip()

    return json.loads(stripped)


def normalize_openai_model(model: str) -> str:
    normalized = model.strip()
    if not normalized:
        return "gpt-5.2"
    return MODEL_ALIASES.get(normalized.lower(), normalized)


def resolve_model_info(model: str) -> Dict[str, Any] | None:
    normalized = model.strip().lower()
    if normalized.startswith("gpt-5.2"):
        return dict(GPT_5_2_MODEL_INFO)
    return None


def resolve_model_capabilities(model_info: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "vision": bool(model_info.get("vision")),
        "function_calling": bool(model_info.get("function_calling")),
        "json_output": bool(model_info.get("json_output")),
    }


def is_responses_only_model(model: str) -> bool:
    return normalize_openai_model(model) in RESPONSES_ONLY_MODELS


RESPONSES_API_EFFORT_MAP: Dict[str, str] = {
    "low": "medium",
    "medium": "medium",
    "high": "high",
}


async def call_responses_api(
    model: str,
    system_prompt: str,
    user_prompt: str,
    api_key: str,
    reasoning_effort: str = "medium",
) -> str:
    from openai import AsyncOpenAI

    effort = RESPONSES_API_EFFORT_MAP.get(reasoning_effort, "medium")
    client = AsyncOpenAI(api_key=api_key)
    try:
        response = await client.responses.create(
            model=model,
            instructions=system_prompt,
            input=user_prompt,
            reasoning={"effort": effort},
        )
        text = response.output_text
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Responses API returned empty output")
        return text
    finally:
        await client.close()


def build_model_client(request: Dict[str, Any], env_model_var: str) -> OpenAIChatCompletionClient:
    ensure_autogen_available()

    provider = str(request.get("provider", "openai")).strip().lower() or "openai"
    if provider != "openai":
        raise ValueError(f"unsupported provider '{provider}'")

    requested_model = str(request.get("model", os.environ.get(env_model_var, "gpt-5.2"))).strip() or "gpt-5.2"
    model = normalize_openai_model(requested_model)
    if model != requested_model:
        log(f"normalized model alias: {requested_model} -> {model}")
    reasoning_effort = str(request.get("reasoningEffort", "low")).strip().lower() or "low"
    if reasoning_effort not in {"low", "medium", "high"}:
        reasoning_effort = "low"

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    model_info = resolve_model_info(model)
    reasoning_supported = reasoning_effort in {"low", "medium", "high"}
    base_kwargs: Dict[str, Any] = {"model": model, "api_key": api_key}
    client_kwargs_candidates: List[Dict[str, Any]] = []

    if model_info is not None:
        model_info_kwargs = dict(base_kwargs)
        model_info_kwargs["model_info"] = dict(model_info)
        if reasoning_supported:
            model_info_with_reasoning_kwargs = dict(model_info_kwargs)
            model_info_with_reasoning_kwargs["reasoning_effort"] = reasoning_effort
            client_kwargs_candidates.append(model_info_with_reasoning_kwargs)
        client_kwargs_candidates.append(model_info_kwargs)

        model_capabilities_kwargs = dict(base_kwargs)
        model_capabilities_kwargs["model_capabilities"] = resolve_model_capabilities(model_info)
        if reasoning_supported:
            model_capabilities_with_reasoning_kwargs = dict(model_capabilities_kwargs)
            model_capabilities_with_reasoning_kwargs["reasoning_effort"] = reasoning_effort
            client_kwargs_candidates.append(model_capabilities_with_reasoning_kwargs)
        client_kwargs_candidates.append(model_capabilities_kwargs)

    if reasoning_supported:
        reasoning_kwargs = dict(base_kwargs)
        reasoning_kwargs["reasoning_effort"] = reasoning_effort
        client_kwargs_candidates.append(reasoning_kwargs)

    client_kwargs_candidates.append(base_kwargs)

    last_error: Exception | None = None
    for candidate in client_kwargs_candidates:
        try:
            return OpenAIChatCompletionClient(**candidate)
        except (TypeError, ValueError) as error:
            last_error = error
            continue

    if last_error is not None:
        raise last_error
    raise RuntimeError("failed to initialize OpenAIChatCompletionClient")


async def classify_title(request: Dict[str, Any]) -> Dict[str, Any]:
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("missing payload")

    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValueError("payload.title is required")

    model_client = build_model_client(request, "AUTO_GEN_MODEL_TITLE")
    agent = AssistantAgent(
        name="TitleIntentClassifierAgent",
        model_client=model_client,
        system_message=TITLE_SYSTEM_PROMPT,
    )

    user_prompt = json.dumps(
        {
            "videoId": str(payload.get("videoId", "")).strip(),
            "title": title,
            "languageHint": str(payload.get("languageHint", "auto")).strip() or "auto",
        },
        ensure_ascii=False,
    )

    try:
        run_result = await agent.run(task=user_prompt)
        content = extract_text_from_agent_result(run_result)
        parsed = parse_agent_json(content)
    finally:
        close_method = getattr(model_client, "close", None)
        if callable(close_method):
            maybe_coroutine = close_method()
            if asyncio.iscoroutine(maybe_coroutine):
                await maybe_coroutine

    return coerce_title_result(parsed, title)


async def classify_description(request: Dict[str, Any]) -> Dict[str, Any]:
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("missing payload")

    description = str(payload.get("description", ""))
    if not description.strip():
        raise ValueError("payload.description is required")

    model_client = build_model_client(request, "AUTO_GEN_MODEL_DESCRIPTION")
    agent = AssistantAgent(
        name="DescriptionClassifierAgent",
        model_client=model_client,
        system_message=DESCRIPTION_SYSTEM_PROMPT,
    )

    urls_with_spans = payload.get("urlsWithSpans")
    if not isinstance(urls_with_spans, list):
        urls_with_spans = []
    urls: List[Dict[str, Any]] = []
    for item in urls_with_spans[:10]:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        domain = item.get("domain")
        char_start = item.get("charStart")
        char_end = item.get("charEnd")
        if not isinstance(url, str) or not isinstance(domain, str):
            continue
        if not isinstance(char_start, int):
            char_start = 0
        if not isinstance(char_end, int):
            char_end = char_start
        start = max(0, min(char_start, len(description)))
        end = max(start, min(char_end, len(description)))
        urls.append(
            {
                "url": url,
                "domain": domain,
                "charStart": start,
                "charEnd": end,
                "snippet": description[start:end],
            }
        )

    user_prompt = json.dumps(
        {
            "videoId": str(payload.get("videoId", "")).strip(),
            "title": str(payload.get("title", "")).strip(),
            "description": description,
            "languageHint": str(payload.get("languageHint", "auto")).strip() or "auto",
            "urls": urls,
        },
        ensure_ascii=False,
    )

    try:
        run_result = await agent.run(task=user_prompt)
        content = extract_text_from_agent_result(run_result)
        parsed = parse_agent_json(content)
    finally:
        close_method = getattr(model_client, "close", None)
        if callable(close_method):
            maybe_coroutine = close_method()
            if asyncio.iscoroutine(maybe_coroutine):
                await maybe_coroutine

    return coerce_description_result(parsed, description)


async def classify_transcript(request: Dict[str, Any]) -> Dict[str, Any]:
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("missing payload")

    segments_sample = payload.get("segmentsSample")
    if not isinstance(segments_sample, list) or not segments_sample:
        raise ValueError("payload.segmentsSample is required")

    model_client = build_model_client(request, "AUTO_GEN_MODEL_DESCRIPTION")
    agent = AssistantAgent(
        name="TranscriptClassifierAgent",
        model_client=model_client,
        system_message=TRANSCRIPT_SYSTEM_PROMPT,
    )

    sample_segments: Dict[int, str] = {}
    for item in segments_sample:
        if not isinstance(item, dict):
            continue
        segment_index = item.get("segmentIndex")
        text = item.get("text")
        if isinstance(segment_index, int) and isinstance(text, str) and text.strip():
            sample_segments[segment_index] = text

    duration_sec = payload.get("durationSec")
    if not isinstance(duration_sec, (int, float)):
        duration_sec = 0

    user_prompt = json.dumps(
        {
            "videoId": str(payload.get("videoId", "")).strip(),
            "title": str(payload.get("title", "")).strip(),
            "durationSec": float(duration_sec),
            "segmentsSample": segments_sample,
            "candidateSponsorSegments": payload.get("candidateSponsorSegments", []),
            "candidateCTASegments": payload.get("candidateCTASegments", []),
        },
        ensure_ascii=False,
    )

    try:
        run_result = await agent.run(task=user_prompt)
        content = extract_text_from_agent_result(run_result)
        parsed = parse_agent_json(content)
    finally:
        close_method = getattr(model_client, "close", None)
        if callable(close_method):
            maybe_coroutine = close_method()
            if asyncio.iscoroutine(maybe_coroutine):
                await maybe_coroutine

    return coerce_transcript_result(parsed, sample_segments)


def build_thumbnail_multimodal_message(user_prompt: str, image_path: str) -> Any:
    from autogen_agentchat.messages import MultiModalMessage

    image_content: Any = None

    try:
        from autogen_core import Image as AutoGenImage  # type: ignore

        if hasattr(AutoGenImage, "from_file") and callable(getattr(AutoGenImage, "from_file")):
            image_content = AutoGenImage.from_file(image_path)  # type: ignore[attr-defined]
    except Exception as error:
        log(f"thumbnail multimodal image helper unavailable: {error}")

    if image_content is None:
        try:
            from PIL import Image as PILImage  # type: ignore

            with PILImage.open(image_path) as image:
                image.verify()
        except Exception as error:
            raise ValueError(f"failed to load thumbnail image: {error}") from error

        with open(image_path, "rb") as image_file:
            encoded = base64.b64encode(image_file.read()).decode("ascii")
        image_content = {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}}

    return MultiModalMessage(content=[user_prompt, image_content], source="user")


async def run_multimodal_agent(agent: AssistantAgent, user_prompt: str, image_path: str) -> Any:
    try:
        message = build_thumbnail_multimodal_message(user_prompt, image_path)
    except Exception as error:
        log(f"thumbnail multimodal fallback to text-only: {error}")
        return await agent.run(task=user_prompt)

    if hasattr(agent, "on_messages"):
        try:
            return await agent.on_messages([message], cancellation_token=None)  # type: ignore[arg-type]
        except TypeError:
            return await agent.on_messages([message])  # type: ignore[arg-type]

    return await agent.run(task=user_prompt)


async def classify_thumbnail(request: Dict[str, Any]) -> Dict[str, Any]:
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("missing payload")

    thumbnail_abs_path = str(payload.get("thumbnailAbsPath", "")).strip()
    if not thumbnail_abs_path:
        raise ValueError("payload.thumbnailAbsPath is required")

    if not os.path.isfile(thumbnail_abs_path):
        raise ValueError(f"thumbnail path does not exist: {thumbnail_abs_path}")

    model_client = build_model_client(request, "AUTO_GEN_MODEL_THUMBNAIL")
    agent = AssistantAgent(
        name="ThumbnailVisionClassifierAgent",
        model_client=model_client,
        system_message=THUMBNAIL_SYSTEM_PROMPT,
    )

    thumb_meta = payload.get("thumbMeta")
    if not isinstance(thumb_meta, dict):
        thumb_meta = {}
    ocr_summary = payload.get("ocrSummary")
    if not isinstance(ocr_summary, dict):
        ocr_summary = {}
    stats_summary = payload.get("statsSummary")
    if not isinstance(stats_summary, dict):
        stats_summary = {}

    user_prompt = json.dumps(
        {
            "videoId": str(payload.get("videoId", "")).strip(),
            "title": str(payload.get("title", "")).strip(),
            "thumbnail": {
                "width": thumb_meta.get("imageWidth", 0),
                "height": thumb_meta.get("imageHeight", 0),
                "fileSizeBytes": thumb_meta.get("fileSizeBytes", 0),
            },
            "ocrSummary": {
                "ocrText": ocr_summary.get("ocrText", ""),
                "ocrWordCount": ocr_summary.get("ocrWordCount", 0),
                "textAreaRatio": ocr_summary.get("textAreaRatio", 0.0),
                "hasBigText": ocr_summary.get("hasBigText", False),
            },
            "imageStats": {
                "brightnessMean": stats_summary.get("brightnessMean", 0.0),
                "contrastStd": stats_summary.get("contrastStd", 0.0),
                "colorfulness": stats_summary.get("colorfulness", 0.0),
                "sharpnessLaplacianVar": stats_summary.get("sharpnessLaplacianVar", 0.0),
                "edgeDensity": stats_summary.get("edgeDensity", 0.0),
            },
        },
        ensure_ascii=False,
    )

    try:
        run_result = await run_multimodal_agent(agent, user_prompt, thumbnail_abs_path)
        content = extract_text_from_agent_result(run_result)
        parsed = parse_agent_json(content)
    finally:
        close_method = getattr(model_client, "close", None)
        if callable(close_method):
            maybe_coroutine = close_method()
            if asyncio.iscoroutine(maybe_coroutine):
                await maybe_coroutine

    return coerce_thumbnail_result(parsed)


async def classify_channel_orchestrator(request: Dict[str, Any]) -> Dict[str, Any]:
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("missing payload")

    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ValueError("payload.rows is required")

    requested_model = str(
        request.get("model", os.environ.get("AUTO_GEN_MODEL_ORCHESTRATOR", "gpt-5.2-pro"))
    ).strip() or "gpt-5.2-pro"
    model = normalize_openai_model(requested_model)
    user_prompt = json.dumps(payload, ensure_ascii=False)

    if is_responses_only_model(model):
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required")
        reasoning_effort = str(request.get("reasoningEffort", "medium")).strip().lower() or "medium"
        log(f"channel orchestrator using Responses API (model={model}, effort={reasoning_effort})")
        content = await call_responses_api(
            model=model,
            system_prompt=CHANNEL_ORCHESTRATOR_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            api_key=api_key,
            reasoning_effort=reasoning_effort,
        )
        parsed = parse_agent_json(content)
    else:
        model_client = build_model_client(request, "AUTO_GEN_MODEL_ORCHESTRATOR")
        agent = AssistantAgent(
            name="ChannelOrchestratorAgent",
            model_client=model_client,
            system_message=CHANNEL_ORCHESTRATOR_SYSTEM_PROMPT,
        )
        try:
            run_result = await agent.run(task=user_prompt)
            content = extract_text_from_agent_result(run_result)
            parsed = parse_agent_json(content)
        finally:
            close_method = getattr(model_client, "close", None)
            if callable(close_method):
                maybe_coroutine = close_method()
                if asyncio.iscoroutine(maybe_coroutine):
                    await maybe_coroutine

    return coerce_channel_orchestrator_result(parsed, payload)


async def classify_request(request: Dict[str, Any]) -> Dict[str, Any]:
    task = request.get("task")
    if task == "title_classifier_v1":
        return await classify_title(request)
    if task == "description_classifier_v1":
        return await classify_description(request)
    if task == "transcript_classifier_v1":
        return await classify_transcript(request)
    if task == "thumbnail_classifier_v1":
        return await classify_thumbnail(request)
    if task == "channel_orchestrator_v1":
        return await classify_channel_orchestrator(request)
    raise ValueError(f"unsupported task '{task}'")


for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue

    request_id = ""
    try:
        payload = json.loads(line)
        request_id = str(payload.get("id", "")).strip()
        if not request_id:
            raise ValueError("missing request id")

        result = asyncio.run(classify_request(payload))
        emit({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        message = str(error) if str(error) else "unknown worker error"
        log(f"request failed id={request_id or 'unknown'}: {message}")
        emit({"id": request_id, "ok": False, "error": message})
