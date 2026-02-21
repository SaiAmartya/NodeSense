"""
NodeSense LLM Service

Two-tier AI strategy:
  - EXTRACTION: Handled by Gemini Nano on-device (in the Chrome extension).
    If Nano is unavailable, the backend uses a fast heuristic fallback
    (title words + content frequency analysis). No Gemini API calls for extraction.
  - SUMMARIZATION: Heuristic page summarization from title + content snippets.
    No API calls — purely local string processing.
  - CHAT: Uses Gemini 2.5 Flash via the Gemini API for rich, contextual responses
    empowered by deep GraphRAG context injection.
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


def _fallback_extract(title: str, content: str, max_kw: int = 12) -> list[str]:
    """
    Smart keyword extraction when LLM is unavailable.
    Combines title words + content frequency analysis.
    Extracts more keywords to capture specific details.
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
        "why", "|", "-", "–", "—", "also", "like", "get", "got", "new",
        "one", "two", "see", "way", "make", "first", "back", "much",
        "well", "even", "come", "take", "many", "good", "know", "help",
        "going", "still", "here", "right", "think", "look", "want",
        "give", "use", "find", "tell", "ask", "work", "seem", "feel",
        "try", "leave", "call",
    }
    words = re.findall(r"[a-zA-Z]{3,}", title)
    keywords = [w.lower() for w in words if w.lower() not in stopwords]

    # Pull keywords from content using frequency analysis
    content_words = re.findall(r"[a-zA-Z]{4,}", content[:3000])
    content_kws = [w.lower() for w in content_words if w.lower() not in stopwords]
    freq: dict[str, int] = {}
    for w in content_kws:
        freq[w] = freq.get(w, 0) + 1
    top = sorted(freq.items(), key=lambda x: x[1], reverse=True)
    keywords.extend([w for w, _ in top[:max_kw] if w not in keywords])

    return keywords[:max_kw]


# ── Page Summarization (Heuristic) ────────────────────────────────────────────
#
# Generates concise page summaries from title + content without API calls.
# These summaries are stored on page nodes to provide semantic depth.


def generate_page_summary(title: str, content: str, url: str = "") -> str:
    """
    Generate a comprehensive page summary from title and content.
    Purely heuristic — no API calls. Extracts multiple informative
    paragraphs and key details from the content to preserve as much
    specific information as possible (dates, names, events, facts).
    """
    if not content and not title:
        return ""

    max_len = settings.MAX_PAGE_SUMMARY_LENGTH

    # Clean up the content
    text = content.strip()
    if not text:
        return title[:max_len] if title else ""

    # Split into sentences (handle common abbreviations)
    sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 15]

    if not sentences:
        # Fall back to first chunk of content
        result = f"{title}: {text}" if title else text
        return result[:max_len]

    # Build summary: pack as many meaningful sentences as possible
    summary_parts = []
    char_count = 0

    # Prepend title context if it's informative
    if title and title.lower() not in text[:200].lower():
        prefix = f"Page: {title}."
        summary_parts.append(prefix)
        char_count += len(prefix) + 1

    for sent in sentences:
        if char_count + len(sent) > max_len:
            # Take as much of this sentence as fits
            remaining = max_len - char_count
            if remaining > 40:
                summary_parts.append(sent[:remaining].rsplit(" ", 1)[0] + "…")
            break
        summary_parts.append(sent)
        char_count += len(sent) + 1

    summary = " ".join(summary_parts)
    return summary[:max_len]


def extract_keyword_snippets(
    content: str, keywords: list[str], max_snippet_len: int = 120
) -> dict[str, str]:
    """
    For each keyword, extract the most relevant sentence or phrase
    from the content where it appears. Returns {keyword: snippet}.
    """
    snippets: dict[str, str] = {}
    if not content:
        return snippets

    # Split content into sentences
    sentences = re.split(r'[.!?\n]+', content)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 15]

    for kw in keywords:
        kw_lower = kw.lower().strip()
        if not kw_lower:
            continue
        # Find the best sentence containing this keyword
        for sent in sentences:
            if kw_lower in sent.lower():
                snippet = sent[:max_snippet_len]
                if len(sent) > max_snippet_len:
                    snippet = snippet.rsplit(" ", 1)[0] + "…"
                snippets[kw_lower] = snippet
                break

    return snippets


# ── Contextual Chat ───────────────────────────────────────────────────────────

# The system prompt template now accepts rich, structured context
# assembled by the GraphRAG pipeline in langgraph_flow.py
SYSTEM_PROMPT = """You are NodeSense, a contextually-aware browser AI assistant.
You have deep insight into the user's current browsing activity through a real-time knowledge graph that tracks their pages, topics, and task clusters.

{context_block}

INSTRUCTIONS:
- Use the above context to understand what the user is currently working on
- Reference specific pages, topics, and patterns from their browsing naturally
- You have access to actual page content under "--- Page Content ---" sections — USE this content to answer specific factual questions about what the user has read (dates, names, events, details, facts)
- When the user asks "what am I working on?", synthesize the trajectory and task clusters into a coherent narrative
- Be specific — cite page titles, specific facts, dates, and details rather than being vague
- If browsing spans multiple tasks, acknowledge the multi-tasking
- Be concise but context-rich; don't repeat raw data, synthesize it
- If you can find the answer in the page content provided, give a direct factual answer
- If confidence is low, note that your understanding is still forming"""


def build_context_block(context: dict[str, Any]) -> str:
    """
    Build the structured context block that gets injected into the system prompt.
    Transforms the rich context dict from the GraphRAG pipeline into a
    human-readable, LLM-optimized context section.

    Now includes comprehensive page content for the most relevant pages,
    enabling the LLM to answer specific detail questions about page content.
    """
    sections: list[str] = []

    # ── Active Task ──
    task_label = context.get("task_label", "Exploring")
    confidence = context.get("confidence", 0.0)
    keywords = context.get("keywords", [])
    sections.append(
        f"== ACTIVE TASK ==\n"
        f"Task: {task_label}\n"
        f"Confidence: {int(confidence * 100)}%\n"
        f"Core topics: {', '.join(keywords) if keywords else 'none detected yet'}"
    )

    # ── Browsing Trajectory (with deep content for recent pages) ──
    trajectory = context.get("trajectory", [])
    if trajectory:
        traj_lines = ["== RECENT BROWSING TRAJECTORY =="]
        deep_content_budget = settings.MAX_DEEP_CONTENT_PAGES
        deep_content_max_len = settings.MAX_DEEP_CONTENT_LENGTH

        for i, page in enumerate(trajectory, 1):
            mins = page.get("minutes_ago", 0)
            if mins < 1:
                time_str = "just now"
            elif mins < 60:
                time_str = f"{int(mins)}m ago"
            else:
                time_str = f"{mins / 60:.1f}h ago"

            title = page.get("title", "Untitled")
            summary = page.get("summary", "")
            content_snippet = page.get("content_snippet", "")
            page_kws = page.get("keywords", [])

            line = f"{i}. \"{title}\" ({time_str})"
            if summary:
                line += f"\n   Summary: {summary}"
            if page_kws:
                line += f"\n   Topics: {', '.join(page_kws)}"

            # Include full page content for the most recent/relevant pages
            if content_snippet and deep_content_budget > 0:
                clipped = content_snippet[:deep_content_max_len]
                line += f"\n   --- Page Content ---\n   {clipped}"
                deep_content_budget -= 1

            traj_lines.append(line)
        sections.append("\n".join(traj_lines))

    # ── Active Community Deep Context ──
    community_context = context.get("community_context", {})
    community_pages = community_context.get("pages", [])
    kw_relationships = community_context.get("keyword_relationships", [])
    stats = community_context.get("stats", {})

    if community_pages:
        comm_lines = [
            f"== ACTIVE TASK CLUSTER ==\n"
            f"Cluster size: {stats.get('total_pages', 0)} pages, "
            f"{stats.get('total_keywords', 0)} keywords, "
            f"{stats.get('total_edges', 0)} connections"
        ]
        comm_lines.append("Key pages in this cluster:")
        deep_cluster_budget = settings.MAX_DEEP_CONTENT_PAGES
        deep_cluster_max_len = settings.MAX_DEEP_CONTENT_LENGTH

        for page in community_pages[:8]:
            title = page.get("title", "Untitled")
            summary = page.get("summary", "")
            content_snippet = page.get("content_snippet", "")
            visits = page.get("visit_count", 1)

            entry = f"  - \"{title}\""
            if visits > 1:
                entry += f" (visited {visits}x)"
            if summary:
                entry += f"\n    Summary: {summary}"

            # Include page content for the most relevant cluster pages
            if content_snippet and deep_cluster_budget > 0:
                clipped = content_snippet[:deep_cluster_max_len]
                entry += f"\n    --- Page Content ---\n    {clipped}"
                deep_cluster_budget -= 1

            comm_lines.append(entry)
        sections.append("\n".join(comm_lines))

    if kw_relationships:
        rel_lines = ["== TOPIC RELATIONSHIPS =="]
        for rel in kw_relationships[:10]:
            rel_lines.append(
                f"  {rel['from']} ↔ {rel['to']} (strength: {rel['weight']})"
            )
        sections.append("\n".join(rel_lines))

    # ── Cross-Community Bridges ──
    bridges = context.get("bridges", [])
    if bridges:
        bridge_lines = ["== CROSS-TOPIC CONNECTIONS =="]
        for b in bridges[:5]:
            targets = ", ".join(b.get("bridges_to", []))
            bridge_lines.append(
                f"  \"{b['keyword']}\" connects {b.get('from_community', '?')} → {targets}"
            )
        sections.append("\n".join(bridge_lines))

    # ── All Task Clusters ──
    all_tasks = context.get("all_tasks", [])
    if len(all_tasks) > 1:
        task_lines = ["== ALL DETECTED TASKS =="]
        for t in all_tasks:
            prob = t.get("probability", 0)
            label = t.get("label", "Unknown")
            kws = ", ".join(t.get("keywords", [])[:6])
            task_lines.append(f"  - {label} ({int(prob * 100)}%): {kws}")
        sections.append("\n".join(task_lines))

    return "\n\n".join(sections)


async def generate_contextual_response(
    query: str,
    context: dict[str, Any],
) -> str:
    """
    Generate a chat response enriched with the user's inferred browsing context.
    This is the ONLY function that calls the Gemini 2.5 Flash API.

    The context dict now contains rich GraphRAG data including:
      - task_label, keywords, confidence (basic)
      - trajectory (recent browsing history with summaries)
      - community_context (pages, keyword relationships in active cluster)
      - bridges (cross-community connections)
      - all_tasks (all detected task clusters)
    """
    global _cooldown_until, _total_gemini_calls
    model = _get_model()
    if model is None or _is_rate_limited():
        return _fallback_chat(query, context)

    context_block = build_context_block(context)
    system = SYSTEM_PROMPT.format(context_block=context_block)

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

    # Build a richer fallback using trajectory if available
    trajectory = context.get("trajectory", [])
    traj_info = ""
    if trajectory:
        recent = trajectory[:3]
        pages = [p.get("title", "?") for p in recent]
        traj_info = f" Recent pages: {', '.join(pages)}."

    return (
        f"Based on your browsing, you're working on **{task}** "
        f"(topics: {kws}).{traj_info} "
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
