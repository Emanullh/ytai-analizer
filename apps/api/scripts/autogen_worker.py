#!/usr/bin/env python3
import asyncio
import base64
import json
import os
import sys
from typing import Any, Dict, List

from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient

TITLE_SYSTEM_PROMPT = """TitleIntentClassifierAgent v1

You are a strict classification agent. You must output ONLY valid JSON (no markdown, no prose).
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

DESCRIPTION_SYSTEM_PROMPT = """DescriptionClassifierAgent v1

You are a strict classification agent. You must output ONLY valid JSON (no markdown, no prose).
Task: classify URL purpose, sponsor brand mentions, and primary CTA from a YouTube description.

INPUT:
You will receive a JSON payload with:
- videoId (string)
- title (string)
- description (string)
- urlsWithSpans (array of {url,domain,charStart,charEnd,isShortener})
- languageHint ("auto"|"en"|"es")

OUTPUT (MUST match this schema exactly):
{
  "schemaVersion": "derived.description_llm.v1",
  "linkPurpose": [
    {
      "url": "string",
      "label": "sponsor|affiliate|sources|social|merch|newsletter|community|other",
      "confidence": 0.0,
      "evidence": {"charStart": 0, "charEnd": 0, "snippet": "string"}
    }
  ],
  "sponsorBrandMentions": [
    {
      "brand": "string",
      "confidence": 0.0,
      "evidence": [{"charStart": 0, "charEnd": 0, "snippet": "string"}]
    }
  ],
  "primaryCTA": {
    "label": "subscribe|like|comment|link|follow|none",
    "confidence": 0.0,
    "evidence": [{"charStart": 0, "charEnd": 0, "snippet": "string"}]
  }
}

RULES:
1) Use ONLY labels from the enums above.
2) linkPurpose should be returned for provided urlsWithSpans (up to 10 urls).
3) Evidence spans MUST point to exact substrings from the original description.
   - charStart/charEnd are zero-based indices, charEnd exclusive.
   - snippet must equal description[charStart:charEnd].
4) Do not infer claims unsupported by the description text.
5) If no sponsor brands are present, return empty sponsorBrandMentions.
6) If no CTA is clear, return primaryCTA.label="none" with low confidence.
7) Return strict JSON only.

Now wait for the JSON input and respond with ONLY the JSON output.
"""

TRANSCRIPT_SYSTEM_PROMPT = """TranscriptClassifierAgent v1

You are a strict classification agent. You must output ONLY valid JSON (no markdown, no prose).
Task: classify story arc, sponsor segments, and CTA segments using ONLY sampled transcript segments.

INPUT:
You will receive a JSON payload with:
- videoId (string)
- title (string)
- languageHint ("auto"|"en"|"es")
- segmentsSample (array of {segmentIndex,startSec,endSec,text})
- candidateSponsorSegments (array of {segmentIndex,startSec,endSec,text})
- candidateCTASegments (array of {segmentIndex,startSec,endSec,text})

OUTPUT (MUST match this schema exactly):
{
  "schemaVersion": "derived.transcript_llm.v1",
  "story_arc": {
    "label": "problem-solution|listicle|timeline|explainer|debate|investigation|tutorial|other",
    "confidence": 0.0,
    "evidenceSegments": [{"segmentIndex": 0, "snippet": "string"}]
  },
  "sponsor_segments": [
    {
      "startSec": 0.0,
      "endSec": 0.0,
      "brand": "string",
      "confidence": 0.0,
      "evidenceSegments": [{"segmentIndex": 0, "snippet": "string"}]
    }
  ],
  "cta_segments": [
    {
      "type": "subscribe|like|comment|link|follow|none",
      "confidence": 0.0,
      "evidenceSegments": [{"segmentIndex": 0, "snippet": "string"}]
    }
  ]
}

RULES:
1) Use ONLY labels from the enums above.
2) evidenceSegments snippets MUST be exact substrings from segmentsSample[*].text.
3) brand MUST appear in at least one sponsor evidence snippet.
4) Do not invent brands or unsupported claims.
5) If no sponsor is detected, return sponsor_segments as [].
6) If no CTA is clear, return one cta_segments item with type="none" and low confidence.
7) Return strict JSON only.

Now wait for the JSON input and respond with ONLY the JSON output.
"""

THUMBNAIL_SYSTEM_PROMPT = """ThumbnailVisionClassifierAgent v1

You are a strict multimodal classification agent. You must output ONLY valid JSON (no markdown, no prose).
Task: classify a YouTube thumbnail using the provided image and deterministic signals.

INPUT:
You will receive:
- thumbnail image
- JSON payload with:
  - videoId (string)
  - title (string)
  - thumbMeta ({thumbnailLocalPath,fileSizeBytes,imageWidth,imageHeight,aspectRatio})
  - ocrSummary ({ocrText,ocrConfidenceMean,ocrCharCount,ocrWordCount,textAreaRatio,hasBigText})
  - statsSummary ({brightnessMean,contrastStd,colorfulness,sharpnessLaplacianVar,edgeDensity,thumb_ocr_title_overlap_jaccard})

OUTPUT (MUST match this schema exactly):
{
  "schemaVersion": "derived.thumbnail_llm.v1",
  "archetype": { "label": "reaction|diagram|logo|portrait|screenshot|text-heavy|collage|other", "confidence": 0.0 },
  "faceSignals": {
    "faceCountBucket": "0|1|2|3plus",
    "dominantFacePosition": { "x": "left|center|right|unknown", "y": "top|mid|bottom|unknown" },
    "faceEmotionTone": "positive|negative|neutral|mixed|unknown",
    "hasEyeContact": true,
    "confidence": 0.0
  },
  "clutterLevel": { "label": "low|medium|high", "confidence": 0.0 },
  "styleTags": [{ "label": "high-contrast|low-contrast|colorful|dark|minimal|cluttered|clean|big-text|no-text|face|no-face|logo-heavy|screenshot-like|diagram-like", "confidence": 0.0 }],
  "evidenceRegions": [{ "label": "string", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 }],
  "evidenceSignals": [{ "fieldName": "string", "value": 0.0 }]
}

RULES:
1) Use ONLY labels from the enums above.
2) styleTags is multi-label, max 6 unique labels.
3) confidence fields are in [0,1].
4) evidenceRegions must use normalized coordinates in [0,1].
5) Do not hallucinate text that is not visible in the image.
6) Use deterministic summary as supporting signals, not as replacement for visual inspection.
7) If faceCountBucket is "0":
   - dominantFacePosition.x and .y should be "unknown"
   - hasEyeContact should be "unknown"
8) Output strict JSON only.

Now wait for the multimodal input and respond with ONLY the JSON output.
"""

CHANNEL_ORCHESTRATOR_SYSTEM_PROMPT = """ChannelOrchestratorAgent v1

You are the final channel research orchestrator. You must output ONLY valid JSON (no markdown, no prose).
You will receive deterministic evidence already computed from a YouTube export.

CRITICAL RULES:
1) Do not compute new statistics, rankings, or correlations.
2) Use only evidence present in the input payload.
3) Every claim in insights/rules/templates must include:
   - supported_by: array of videoIds from input rows
   - evidence_fields: array of valid dotted paths from row fields
4) Never reference a videoId that is not in input rows.
5) Never invent evidence fields.

OUTPUT JSON (exact top-level shape):
{
  "playbook": {
    "schemaVersion": "analysis.playbook.v1",
    "generatedAt": "ISO-8601 string",
    "channel": {
      "channelId": "string",
      "channelName": "string",
      "timeframe": "1m|6m|1y",
      "jobId": "string"
    },
    "warnings": ["string"],
    "insights": [
      {
        "id": "string",
        "title": "string",
        "summary": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["performance.residual"]
      }
    ],
    "rules": [
      {
        "id": "string",
        "name": "string",
        "recommendation": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["titleFeatures.deterministic.has_number"]
      }
    ],
    "keys": [
      {
        "id": "string",
        "label": "string",
        "rationale": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["thumbnailFeatures.deterministic.textAreaRatio"]
      }
    ],
    "evidence": {
      "cohorts": [],
      "drivers": [],
      "exemplars": {}
    }
  },
  "templates": {
    "schemaVersion": "derived.templates.v1",
    "generatedAt": "ISO-8601 string",
    "channel": {
      "channelId": "string",
      "channelName": "string",
      "timeframe": "1m|6m|1y",
      "jobId": "string"
    },
    "warnings": ["string"],
    "titleTemplates": [
      {
        "id": "string",
        "template": "string",
        "when_to_use": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["titleFeatures.deterministic.question_mark_count"]
      }
    ],
    "thumbnailTemplates": [
      {
        "id": "string",
        "template": "string",
        "when_to_use": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["thumbnailFeatures.llm.archetype"]
      }
    ],
    "scriptTemplates": [
      {
        "id": "string",
        "template": "string",
        "when_to_use": "string",
        "supported_by": ["videoId"],
        "evidence_fields": ["transcriptFeatures.deterministic.promise_delivery_30s_score"]
      }
    ]
  }
}

If evidence is weak, return fewer items and include warnings.
Return strict JSON only.
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


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


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
    return {
        "schemaVersion": "derived.title_llm.v1",
        "promise_type": normalize_multi_label(source.get("promise_type", []), title, PROMISE_LABELS),
        "curiosity_gap_type": normalize_multi_label(source.get("curiosity_gap_type", []), title, CURIOSITY_LABELS),
        "headline_claim_strength": normalize_claim_strength(source.get("headline_claim_strength"), title),
    }


def coerce_description_result(raw: Any, description: str) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}

    link_purpose: List[Dict[str, Any]] = []
    if isinstance(source.get("linkPurpose"), list):
        for item in source.get("linkPurpose", []):
            if not isinstance(item, dict):
                continue

            url = item.get("url")
            label = item.get("label")
            if not isinstance(url, str) or not url.strip():
                continue
            if not isinstance(label, str) or label not in LINK_PURPOSE_LABELS:
                continue

            link_purpose.append(
                {
                    "url": url.strip(),
                    "label": label,
                    "confidence": clamp_01(item.get("confidence", 0.0)),
                    "evidence": normalize_single_evidence(item.get("evidence"), description),
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
    if isinstance(source.get("sponsor_segments"), list):
        for item in source.get("sponsor_segments", []):
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

    cta_segments: List[Dict[str, Any]] = []
    if isinstance(source.get("cta_segments"), list):
        for item in source.get("cta_segments", []):
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
    raw_regions = source.get("evidenceRegions")
    if isinstance(raw_regions, list):
        for item in raw_regions:
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
    raw_signals = source.get("evidenceSignals")
    if isinstance(raw_signals, list):
        for item in raw_signals:
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
        generated_at = ""

    playbook_source = playbook_raw if isinstance(playbook_raw, dict) else {}
    templates_source = templates_raw if isinstance(templates_raw, dict) else {}

    playbook = {
        "schemaVersion": "analysis.playbook.v1",
        "generatedAt": str(playbook_source.get("generatedAt", generated_at)),
        "channel": playbook_source.get("channel")
        if isinstance(playbook_source.get("channel"), dict)
        else channel_fallback,
        "warnings": [str(item) for item in playbook_source.get("warnings", []) if isinstance(item, str)]
        if isinstance(playbook_source.get("warnings"), list)
        else [],
        "insights": _normalize_claim_list(playbook_source.get("insights"), "insight"),
        "rules": _normalize_claim_list(playbook_source.get("rules"), "rule"),
        "keys": _normalize_claim_list(playbook_source.get("keys"), "key"),
        "evidence": playbook_source.get("evidence") if isinstance(playbook_source.get("evidence"), dict) else {},
    }

    templates = {
        "schemaVersion": "derived.templates.v1",
        "generatedAt": str(templates_source.get("generatedAt", generated_at)),
        "channel": templates_source.get("channel")
        if isinstance(templates_source.get("channel"), dict)
        else channel_fallback,
        "warnings": [str(item) for item in templates_source.get("warnings", []) if isinstance(item, str)]
        if isinstance(templates_source.get("warnings"), list)
        else [],
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


def build_model_client(request: Dict[str, Any], env_model_var: str) -> OpenAIChatCompletionClient:
    provider = str(request.get("provider", "openai")).strip().lower() or "openai"
    if provider != "openai":
        raise ValueError(f"unsupported provider '{provider}'")

    model = str(request.get("model", os.environ.get(env_model_var, "gpt-5.2"))).strip() or "gpt-5.2"
    reasoning_effort = str(request.get("reasoningEffort", "low")).strip().lower() or "low"
    if reasoning_effort not in {"low", "medium", "high"}:
        reasoning_effort = "low"

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")

    client_kwargs: Dict[str, Any] = {"model": model, "api_key": api_key}
    if reasoning_effort in {"low", "medium", "high"}:
        client_kwargs["reasoning_effort"] = reasoning_effort

    try:
        return OpenAIChatCompletionClient(**client_kwargs)
    except TypeError:
        client_kwargs.pop("reasoning_effort", None)
        return OpenAIChatCompletionClient(**client_kwargs)


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
            "task": "title_classifier_v1",
            "title": title,
            "languageHint": str(payload.get("languageHint", "auto")).strip() or "auto",
            "requiredOutput": {
                "schemaVersion": "derived.title_llm.v1",
                "promise_type": "array of label+score+confidence+evidence",
                "curiosity_gap_type": "array of label+score+confidence+evidence",
                "headline_claim_strength": "object(label/confidence/evidence) or null",
            },
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

    user_prompt = json.dumps(
        {
            "task": "description_classifier_v1",
            "videoId": str(payload.get("videoId", "")).strip(),
            "title": str(payload.get("title", "")).strip(),
            "description": description,
            "urlsWithSpans": urls_with_spans[:10],
            "languageHint": str(payload.get("languageHint", "auto")).strip() or "auto",
            "requiredOutput": {
                "schemaVersion": "derived.description_llm.v1",
                "linkPurpose": "array(url,label,confidence,evidence)",
                "sponsorBrandMentions": "array(brand,confidence,evidence[])",
                "primaryCTA": "object(label,confidence,evidence[]) or null",
            },
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

    user_prompt = json.dumps(
        {
            "task": "transcript_classifier_v1",
            "videoId": str(payload.get("videoId", "")).strip(),
            "title": str(payload.get("title", "")).strip(),
            "languageHint": str(payload.get("languageHint", "auto")).strip() or "auto",
            "segmentsSample": segments_sample,
            "candidateSponsorSegments": payload.get("candidateSponsorSegments", []),
            "candidateCTASegments": payload.get("candidateCTASegments", []),
            "requiredOutput": {
                "schemaVersion": "derived.transcript_llm.v1",
                "story_arc": "object(label,confidence,evidenceSegments[]) or null",
                "sponsor_segments": "array(startSec,endSec,brand,confidence,evidenceSegments[])",
                "cta_segments": "array(type,confidence,evidenceSegments[])",
            },
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

    user_prompt = json.dumps(
        {
            "task": "thumbnail_classifier_v1",
            "videoId": str(payload.get("videoId", "")).strip(),
            "title": str(payload.get("title", "")).strip(),
            "thumbMeta": payload.get("thumbMeta", {}),
            "ocrSummary": payload.get("ocrSummary", {}),
            "statsSummary": payload.get("statsSummary", {}),
            "requiredOutput": {
                "schemaVersion": "derived.thumbnail_llm.v1",
                "archetype": "object(label,confidence)",
                "faceSignals": "object(faceCountBucket,dominantFacePosition{x,y},faceEmotionTone,hasEyeContact,confidence)",
                "clutterLevel": "object(label,confidence)",
                "styleTags": "array(label,confidence), max 6",
                "evidenceRegions": "array(label,x,y,w,h) normalized in [0,1]",
                "evidenceSignals": "array(fieldName,value) using deterministic fields",
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

    model_client = build_model_client(request, "AUTO_GEN_MODEL_ORCHESTRATOR")
    agent = AssistantAgent(
        name="ChannelOrchestratorAgent",
        model_client=model_client,
        system_message=CHANNEL_ORCHESTRATOR_SYSTEM_PROMPT,
    )

    user_prompt = json.dumps(
        {
            "task": "channel_orchestrator_v1",
            "payload": payload,
            "requiredOutput": {
                "playbook": "analysis.playbook.v1",
                "templates": "derived.templates.v1",
                "mandatoryEvidence": ["supported_by", "evidence_fields"],
            },
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
