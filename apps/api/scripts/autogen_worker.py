#!/usr/bin/env python3
import asyncio
import json
import os
import sys
from typing import Any, Dict, List

from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient

SYSTEM_PROMPT = """TitleIntentClassifierAgent v1

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


def normalize_evidence(raw: Any, title: str) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []

    normalized: List[Dict[str, Any]] = []
    title_len = len(title)
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

        start = max(0, min(start, title_len))
        end = max(start, min(end, title_len))

        if not isinstance(snippet, str) or not snippet.strip():
            snippet = title[start:end]

        normalized.append({"charStart": start, "charEnd": end, "snippet": snippet})

    return normalized


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


def coerce_result(raw: Any, title: str) -> Dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    return {
        "schemaVersion": "derived.title_llm.v1",
        "promise_type": normalize_multi_label(source.get("promise_type", []), title, PROMISE_LABELS),
        "curiosity_gap_type": normalize_multi_label(source.get("curiosity_gap_type", []), title, CURIOSITY_LABELS),
        "headline_claim_strength": normalize_claim_strength(source.get("headline_claim_strength"), title),
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


async def classify_title(request: Dict[str, Any]) -> Dict[str, Any]:
    task = request.get("task")
    if task != "title_classifier_v1":
        raise ValueError(f"unsupported task '{task}'")

    provider = str(request.get("provider", "openai")).strip().lower() or "openai"
    if provider != "openai":
        raise ValueError(f"unsupported provider '{provider}'")

    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("missing payload")

    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValueError("payload.title is required")

    model = str(request.get("model", os.environ.get("AUTO_GEN_MODEL_TITLE", "gpt-5.2"))).strip() or "gpt-5.2"
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
        model_client = OpenAIChatCompletionClient(**client_kwargs)
    except TypeError:
        client_kwargs.pop("reasoning_effort", None)
        model_client = OpenAIChatCompletionClient(**client_kwargs)

    agent = AssistantAgent(
        name="TitleIntentClassifierAgent",
        model_client=model_client,
        system_message=SYSTEM_PROMPT,
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

    return coerce_result(parsed, title)


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

        result = asyncio.run(classify_title(payload))
        emit({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        message = str(error) if str(error) else "unknown worker error"
        log(f"request failed id={request_id or 'unknown'}: {message}")
        emit({"id": request_id, "ok": False, "error": message})
