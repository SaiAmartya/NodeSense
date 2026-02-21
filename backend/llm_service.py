"""
NodeSense LLM Service

Two-tier AI strategy:
  - EXTRACTION: Handled by Gemini Nano on-device (in the Chrome extension).
    If Nano is unavailable, the backend uses a fast heuristic fallback
    (title words + content frequency analysis). No Gemini API calls for extraction.
  - CHAT: Uses Gemini 2.5 Flash via the Gemini API for rich, contextual responses
    empowered by GraphRAG context injection.
  - 429 errors on chat: immediate fallback response + 60s cooldown.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

import google.generativeai as genai

from config import settings

logger = logging.getLogger(__name__)

# ── Rate Limiter State ────────────────────────────────────────────────────────

_cooldown_until = 0.0           # if set, no Gemini calls until this timestamp
_total_gemini_calls = 0         # counter for monitoring

# ── Initialize Gemini (for chat only) ─────────────────────────────────────────

_model = None


def _get_model():
    """Lazy-initialize the Gemini model (used exclusively for chat)."""
    global _model
    if _model is None:
        if not settings.GEMINI_API_KEY or settings.GEMINI_API_KEY.startswith("your-"):
            logger.warning("GEMINI_API_KEY not set — chat will use fallback responses")
            return None
        genai.configure(api_key=settings.GEMINI_API_KEY)
        _model = genai.GenerativeModel(settings.GEMINI_MODEL)
    return _model


def _is_rate_limited() -> bool:
    """Check if we should skip Gemini calls due to rate limiting."""
    return time.time() < _cooldown_until


# ── Entity Extraction (Heuristic Fallback) ────────────────────────────────────
#
# Primary extraction is handled by Gemini Nano in the Chrome extension.
# This fallback runs when Nano is unavailable and the extension sends
# raw content instead of pre-extracted keywords.


async def extract_entities(
    content: str,
    title: str,
    url: str = "",
    n: int | None = None,
) -> list[str]:
    """
    Heuristic keyword extraction from page content.

    This is the backend fallback for when Gemini Nano is unavailable
    in the extension. Combines title words + content frequency analysis.
    No API calls are made — this is purely local string processing.
    """
    max_kw = n or settings.MAX_KEYWORDS_PER_PAGE
    truncated = content[: settings.MAX_CONTENT_LENGTH]
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
    This is the ONLY function that calls the Gemini 2.5 Flash API.
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
    """Return current LLM stats for diagnostics."""
    now = time.time()
    return {
        "total_gemini_chat_calls": _total_gemini_calls,
        "cooldown_active": now < _cooldown_until,
        "cooldown_remaining_s": max(0, _cooldown_until - now),
        "extraction_strategy": "gemini_nano_on_device (fallback: backend heuristic)",
        "chat_model": settings.GEMINI_MODEL,
    }
