#!/usr/bin/env python3
import asyncio
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


def extract_text_from_agent_result(run_result: Any) -> str:
    if isinstance(run_result, str):
        return run_result

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


async def classify_request(request: Dict[str, Any]) -> Dict[str, Any]:
    task = request.get("task")
    if task == "title_classifier_v1":
        return await classify_title(request)
    if task == "description_classifier_v1":
        return await classify_description(request)
    if task == "transcript_classifier_v1":
        return await classify_transcript(request)
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
