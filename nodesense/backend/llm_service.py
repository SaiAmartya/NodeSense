"""
NodeSense LLM Service
Wraps Google Gemini API for entity extraction and contextual chat responses.

RATE-LIMITING STRATEGY:
  - Entity extraction: uses FALLBACK by default (fast, free, always available).
    Gemini is only used for extraction if explicitly requested or if cooldown
    has elapsed (LLM_EXTRACTION_COOLDOWN_S seconds since last call).
  - Chat responses: always use Gemini (user-initiated, one-at-a-time).
  - 429 errors: immediately fallback, set a cooldown penalty.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any

import google.generativeai as genai

from config import settings

logger = logging.getLogger(__name__)

# ── Rate Limiter State ────────────────────────────────────────────────────────

LLM_EXTRACTION_COOLDOWN_S = 60  # min seconds between Gemini extraction calls
_last_extraction_call = 0.0     # timestamp of last successful Gemini extraction
_cooldown_until = 0.0           # if set, no Gemini calls until this timestamp
_total_gemini_calls = 0         # counter for monitoring

# ── Initialize Gemini ─────────────────────────────────────────────────────────

_model = None


def _get_model():
    """Lazy-initialize the Gemini model."""
    global _model
    if _model is None:
        if not settings.GEMINI_API_KEY or settings.GEMINI_API_KEY.startswith("your-"):
            logger.warning("GEMINI_API_KEY not set — LLM calls will use fallback logic")
            return None
        genai.configure(api_key=settings.GEMINI_API_KEY)
        _model = genai.GenerativeModel(settings.GEMINI_MODEL)
    return _model


def _is_rate_limited() -> bool:
    """Check if we should skip Gemini calls due to rate limiting."""
    now = time.time()
    if now < _cooldown_until:
        return True
    return False


def _is_extraction_on_cooldown() -> bool:
    """Check if we've called Gemini for extraction too recently."""
    now = time.time()
    return (now - _last_extraction_call) < LLM_EXTRACTION_COOLDOWN_S
    return _model


# ── Entity Extraction ─────────────────────────────────────────────────────────

EXTRACTION_PROMPT = """Extract {n} key topic keywords/phrases from this web page content.
Return ONLY a JSON array of lowercase strings. No explanation.

Example output: ["machine learning", "neural networks", "python", "tensorflow"]

Title: {title}
URL: {url}
Content (truncated):
{content}"""


async def extract_entities(
    content: str,
    title: str,
    url: str = "",
    n: int | None = None,
    force_llm: bool = False,
) -> list[str]:
    """
    Extract key topic keywords from page content.

    Strategy:
      - By default, uses fast fallback extraction (title + content frequency).
      - Only calls Gemini if force_llm=True AND cooldown has elapsed.
      - This prevents flooding the API on every single page visit.
    """
    global _last_extraction_call, _cooldown_until, _total_gemini_calls
    max_kw = n or settings.MAX_KEYWORDS_PER_PAGE
    truncated = content[: settings.MAX_CONTENT_LENGTH]

    # Fast path: use fallback unless LLM is explicitly requested
    if not force_llm:
        return _fallback_extract(title, truncated, max_kw)

    # Check if Gemini is available and not rate-limited
    model = _get_model()
    if model is None:
        return _fallback_extract(title, truncated, max_kw)
    if _is_rate_limited() or _is_extraction_on_cooldown():
        logger.debug("Gemini extraction skipped (cooldown/rate-limited)")
        return _fallback_extract(title, truncated, max_kw)

    prompt = EXTRACTION_PROMPT.format(
        n=max_kw, title=title, url=url, content=truncated
    )

    try:
        response = await _call_with_retry(model, prompt, max_retries=1)
        _last_extraction_call = time.time()
        _total_gemini_calls += 1
        text = response.text.strip()
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
        keywords = json.loads(text)
        if isinstance(keywords, list):
            return [str(k).lower().strip() for k in keywords[:max_kw] if k]
    except Exception as e:
        err_str = str(e)
        if "429" in err_str:
            # Rate limited — set a 60s penalty and fallback
            _cooldown_until = time.time() + 60
            logger.warning("Gemini 429 — entering 60s cooldown, using fallback")
        else:
            logger.warning(f"Gemini entity extraction failed: {e}")

    return _fallback_extract(title, truncated, max_kw)


def _fallback_extract(title: str, content: str, max_kw: int = 5) -> list[str]:
    """
    Smart keyword extraction when LLM is unavailable.
    Combines title words + content frequency analysis.
    """
    stopwords = {
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "shall", "can", "need", "dare", "ought",
        "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
        "as", "into", "through", "during", "before", "after", "above",
        "below", "between", "out", "off", "over", "under", "again",
        "further", "then", "once", "and", "but", "or", "nor", "not", "so",
        "yet", "both", "either", "neither", "each", "every", "all", "any",
        "few", "more", "most", "other", "some", "such", "no", "only", "own",
        "same", "than", "too", "very", "just", "because", "about", "this",
        "that", "these", "those", "it", "its", "i", "me", "my", "we", "our",
        "you", "your", "he", "him", "his", "she", "her", "they", "them",
        "their", "what", "which", "who", "whom", "how", "when", "where",
        "why", "|", "-", "–", "—",
    }
    words = re.findall(r"[a-zA-Z]{3,}", title)
    keywords = [w.lower() for w in words if w.lower() not in stopwords]

    # If title gives too few, pull from content
    if len(keywords) < 3:
        content_words = re.findall(r"[a-zA-Z]{4,}", content[:500])
        content_kws = [w.lower() for w in content_words if w.lower() not in stopwords]
        # Frequency-based selection
        freq: dict[str, int] = {}
        for w in content_kws:
            freq[w] = freq.get(w, 0) + 1
        top = sorted(freq.items(), key=lambda x: x[1], reverse=True)
        keywords.extend([w for w, _ in top[:5] if w not in keywords])

    return keywords[:max_kw]


# ── Contextual Chat ───────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are NodeSense, a contextually-aware browser assistant.
You understand the user's current browsing context and help them based on what they're working on.

Current context:
- Active task: {task_label}
- Related topics: {keywords}
- Confidence: {confidence}%

Recent browsing topics give you insight into what the user is focused on.
Be helpful, concise, and context-aware. Reference the user's current work naturally."""


async def generate_contextual_response(
    query: str,
    context: dict[str, Any],
) -> str:
    """
    Generate a chat response enriched with the user's inferred browsing context.
    """
    global _cooldown_until, _total_gemini_calls
    model = _get_model()
    if model is None or _is_rate_limited():
        return _fallback_chat(query, context)

    system = SYSTEM_PROMPT.format(
        task_label=context.get("task_label", "Exploring"),
        keywords=", ".join(context.get("keywords", [])),
        confidence=int(context.get("confidence", 0) * 100),
    )

    try:
        chat = model.start_chat(history=[])
        response = await _call_chat_with_retry(chat, f"{system}\n\nUser: {query}", max_retries=2)
        _total_gemini_calls += 1
        return response.text.strip()
    except Exception as e:
        err_str = str(e)
        if "429" in err_str:
            _cooldown_until = time.time() + 60
            logger.warning("Gemini chat 429 — entering 60s cooldown")
        else:
            logger.warning(f"Gemini chat failed: {e}")
        return _fallback_chat(query, context)


def _fallback_chat(query: str, context: dict[str, Any]) -> str:
    """Simple fallback when Gemini is unavailable."""
    task = context.get("task_label", "Exploring")
    kws = ", ".join(context.get("keywords", []))
    if task == "Exploring":
        return (
            f"I'm tracking your browsing but haven't identified a clear task yet. "
            f"You asked: \"{query}\". Keep browsing and I'll learn your context!"
        )
    return (
        f"Based on your browsing, you're working on **{task}** "
        f"(topics: {kws}). "
        f"You asked: \"{query}\". "
        f"I'd need the Gemini API key configured to give a proper answer. "
        f"Set GEMINI_API_KEY in your .env file."
    )


# ── Retry Logic ───────────────────────────────────────────────────────────────


async def _call_with_retry(model, prompt: str, max_retries: int = 1):
    """Call model.generate_content_async with async backoff. Minimal retries."""
    for attempt in range(max_retries + 1):
        try:
            return await model.generate_content_async(prompt)
        except Exception as e:
            if attempt == max_retries:
                raise
            # On 429, don't bother retrying — just raise immediately
            if "429" in str(e):
                raise
            delay = min(2 ** attempt, 4)
            logger.warning(f"Gemini retry {attempt + 1}/{max_retries} after {delay}s: {e}")
            await asyncio.sleep(delay)


async def _call_chat_with_retry(chat, message: str, max_retries: int = 1):
    """Call chat.send_message_async with async backoff."""
    for attempt in range(max_retries + 1):
        try:
            return await chat.send_message_async(message)
        except Exception as e:
            if attempt == max_retries:
                raise
            if "429" in str(e):
                raise
            delay = min(2 ** attempt, 4)
            logger.warning(f"Gemini chat retry {attempt + 1}/{max_retries} after {delay}s: {e}")
            await asyncio.sleep(delay)


def get_llm_stats() -> dict:
    """Return current LLM rate-limiter stats for diagnostics."""
    now = time.time()
    return {
        "total_gemini_calls": _total_gemini_calls,
        "cooldown_active": now < _cooldown_until,
        "cooldown_remaining_s": max(0, _cooldown_until - now),
        "extraction_cooldown_remaining_s": max(0, LLM_EXTRACTION_COOLDOWN_S - (now - _last_extraction_call)),
    }
