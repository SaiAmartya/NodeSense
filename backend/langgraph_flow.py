"""
NodeSense LangGraph Orchestration
Defines two stateful workflows:
  1. Page Analysis  — extract → summarize → graph update → community detect → Bayes infer
  2. Chat           — retrieve context → assemble deep context → generate response

Each workflow is a compiled LangGraph StateGraph that can be invoked as a
plain Python callable.

The page analysis pipeline now enriches graph nodes with page summaries and
content snippets, enabling the chat workflow to assemble deep, structured
context (browsing trajectory, community details, keyword relationships,
cross-community bridges) for LLM consumption.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Set
from typing_extensions import TypedDict

from langgraph.graph import StateGraph, START, END

from graph_service import GraphService
from bayesian import BayesianTaskInferrer
from config import settings
import llm_service


# ══════════════════════════════════════════════════════════════════════════════
#  Shared State Types
# ══════════════════════════════════════════════════════════════════════════════


class PageAnalysisState(TypedDict, total=False):
    """State flowing through the page-analysis workflow."""

    # ── inputs ──
    url: str
    title: str
    content: str
    timestamp: float

    # ── intermediate ──
    keywords: list[str]
    summary: str
    content_snippet: str
    communities: list[set]
    posteriors: dict[int, float]

    # ── output ──
    active_context: dict[str, Any]


class ChatState(TypedDict, total=False):
    """State flowing through the chat workflow."""

    # ── inputs ──
    query: str
    session_id: Optional[str]

    # ── intermediate ──
    active_context: dict[str, Any]

    # ── output ──
    response: str


# ══════════════════════════════════════════════════════════════════════════════
#  Workflow Builder
# ══════════════════════════════════════════════════════════════════════════════


class NodeSenseWorkflows:
    """
    Builds and holds the two LangGraph workflows, sharing the same
    GraphService and BayesianTaskInferrer instances.
    """

    def __init__(self, graph_service: GraphService):
        self.gs = graph_service
        self.inferrer = BayesianTaskInferrer()
        self._cached_context: dict[str, Any] = {
            "task_label": "Exploring",
            "keywords": [],
            "confidence": 0.0,
            "all_tasks": [],
        }

        # Build & compile
        self.analyze_graph = self._build_analysis_workflow()
        self.chat_graph = self._build_chat_workflow()

    # ── Page Analysis Workflow ────────────────────────────────────────────

    def _build_analysis_workflow(self):
        builder = StateGraph(PageAnalysisState)

        # Register nodes
        builder.add_node("extract_entities", self._node_extract_entities)
        builder.add_node("generate_summary", self._node_generate_summary)
        builder.add_node("update_graph", self._node_update_graph)
        builder.add_node("detect_communities", self._node_detect_communities)
        builder.add_node("infer_task", self._node_infer_task)

        # Wire edges
        builder.add_edge(START, "extract_entities")
        builder.add_edge("extract_entities", "generate_summary")
        builder.add_edge("generate_summary", "update_graph")
        builder.add_edge("update_graph", "detect_communities")
        builder.add_edge("detect_communities", "infer_task")
        builder.add_edge("infer_task", END)

        return builder.compile()

    async def _node_extract_entities(self, state: PageAnalysisState) -> dict:
        """Node 1: Use pre-extracted Nano keywords or fall back to heuristic.

        If the extension sent pre-extracted keywords (from Gemini Nano),
        use them directly. Otherwise, fall back to the backend's
        heuristic extraction from raw content.
        """
        existing = state.get("keywords")
        if existing and len(existing) > 0:
            # Nano already extracted keywords on-device — skip backend extraction
            return {"keywords": existing}

        # Fallback: extract from raw content using heuristic
        keywords = await llm_service.extract_entities(
            content=state.get("content", ""),
            title=state.get("title", ""),
            url=state.get("url", ""),
        )
        return {"keywords": keywords}

    async def _node_generate_summary(self, state: PageAnalysisState) -> dict:
        """Node 2: Generate a page summary from title + content.

        If a summary was pre-provided (e.g., from Nano), use it.
        Otherwise, generate one heuristically from the content.
        Also prepares a content snippet for storage — uses the full
        configured MAX_CONTEXT_SNIPPET_LENGTH for comprehensive storage.
        """
        existing_summary = state.get("summary", "")
        content = state.get("content", "")
        title = state.get("title", "")
        url = state.get("url", "")
        snippet_len = settings.MAX_CONTEXT_SNIPPET_LENGTH

        if existing_summary:
            return {
                "summary": existing_summary,
                "content_snippet": content[:snippet_len] if content else "",
            }

        summary = llm_service.generate_page_summary(title, content, url)
        content_snippet = content[:snippet_len] if content else ""

        return {"summary": summary, "content_snippet": content_snippet}

    async def _node_update_graph(self, state: PageAnalysisState) -> dict:
        """Node 3: Add the page visit to the NetworkX knowledge graph.

        Now stores summary and content snippet on the page node
        for rich context retrieval during chat.
        """
        self.gs.add_page_visit(
            url=state["url"],
            title=state["title"],
            keywords=state.get("keywords", []),
            timestamp=state.get("timestamp", time.time()),
            summary=state.get("summary", ""),
            content_snippet=state.get("content_snippet", ""),
        )
        # Apply temporal decay on every update
        self.gs.apply_temporal_decay()
        return {}

    async def _node_detect_communities(self, state: PageAnalysisState) -> dict:
        """Node 4: Run Louvain community detection."""
        communities = self.gs.detect_communities()
        return {"communities": communities}

    async def _node_infer_task(self, state: PageAnalysisState) -> dict:
        """Node 5: Bayesian inference + rich context assembly.

        Computes posteriors, determines the active task, then assembles
        deep context including page summaries, browsing trajectory,
        keyword relationships, and cross-community bridges.
        """
        communities = state.get("communities", [])
        keywords = state.get("keywords", [])

        posteriors = self.inferrer.compute_posteriors(
            current_keywords=keywords,
            communities=communities,
            graph=self.gs.graph,
        )

        active_context = self.inferrer.get_active_context(
            posteriors=posteriors,
            communities=communities,
            community_labels=self.gs.community_labels,
            graph=self.gs.graph,
        )

        # ── Enrich with deep GraphRAG context ──
        active_context = self._enrich_context(active_context, posteriors)

        # Cache the latest context for chat queries
        self._cached_context = active_context

        return {"posteriors": posteriors, "active_context": active_context}

    # ── Chat Workflow ─────────────────────────────────────────────────────

    def _build_chat_workflow(self):
        builder = StateGraph(ChatState)

        builder.add_node("retrieve_context", self._node_retrieve_context)
        builder.add_node("assemble_deep_context", self._node_assemble_deep_context)
        builder.add_node("generate_response", self._node_generate_response)

        builder.add_edge(START, "retrieve_context")
        builder.add_edge("retrieve_context", "assemble_deep_context")
        builder.add_edge("assemble_deep_context", "generate_response")
        builder.add_edge("generate_response", END)

        return builder.compile()

    async def _node_retrieve_context(self, state: ChatState) -> dict:
        """Fetch the most recent active context from the cache."""
        return {"active_context": self._cached_context}

    async def _node_assemble_deep_context(self, state: ChatState) -> dict:
        """Assemble deep GraphRAG context for the chat response.

        Re-enriches the cached context with fresh trajectory and
        community data in case the graph has been updated since
        the last page analysis.
        """
        context = state.get("active_context", self._cached_context)

        # Find which community is active based on cached task label
        if context.get("confidence", 0) > 0:
            # Re-enrich with latest graph data
            posteriors = {}
            for task in context.get("all_tasks", []):
                idx = task.get("community_idx", 0)
                posteriors[idx] = task.get("probability", 0)
            context = self._enrich_context(context, posteriors)

        return {"active_context": context}

    async def _node_generate_response(self, state: ChatState) -> dict:
        """Use the Gemini API (with deep context injection) to answer the user."""
        context = state.get("active_context", self._cached_context)
        query = state.get("query", "")

        response = await llm_service.generate_contextual_response(
            query=query, context=context
        )
        return {"response": response}

    # ── Context Enrichment ────────────────────────────────────────────────

    def _enrich_context(
        self,
        active_context: dict[str, Any],
        posteriors: dict[int, float],
    ) -> dict[str, Any]:
        """
        Enrich the basic active_context with deep GraphRAG data:
          1. Browsing trajectory (recent pages with summaries)
          2. Active community deep context (pages, keyword relationships)
          3. Cross-community bridges (connecting concepts)

        This transforms thin keyword-list context into rich, structured
        context that gives the LLM genuine understanding of user activity.
        """
        enriched = dict(active_context)

        # 1. Browsing trajectory
        enriched["trajectory"] = self.gs.get_browsing_trajectory()

        # 2. Active community deep context
        if posteriors:
            ranked = sorted(posteriors.items(), key=lambda x: x[1], reverse=True)
            top_community_idx = ranked[0][0]
            enriched["community_context"] = self.gs.get_rich_community_context(
                community_idx=top_community_idx
            )
        else:
            enriched["community_context"] = {}

        # 3. Cross-community bridges
        enriched["bridges"] = self.gs.get_cross_community_bridges()

        return enriched

    # ── Public API ────────────────────────────────────────────────────────

    async def analyze_page(
        self,
        url: str,
        title: str,
        content: str,
        timestamp: float | None = None,
        keywords: list[str] | None = None,
        summary: str | None = None,
    ) -> dict[str, Any]:
        """
        Run the full page-analysis pipeline.
        Returns the final state including active_context.

        If keywords are provided (pre-extracted by Gemini Nano), the
        extraction node will use them directly instead of running
        backend-side extraction.

        If summary is provided, it will be stored on the page node.
        Otherwise, one is generated heuristically from the content.
        """
        init_state: dict[str, Any] = {
            "url": url,
            "title": title,
            "content": content,
            "timestamp": timestamp or time.time(),
        }
        if keywords:
            init_state["keywords"] = keywords
        if summary:
            init_state["summary"] = summary

        result = await self.analyze_graph.ainvoke(init_state)
        return result

    async def chat(self, query: str, session_id: str | None = None) -> dict[str, Any]:
        """
        Run the chat pipeline.
        Returns the final state including response.
        """
        result = await self.chat_graph.ainvoke(
            {"query": query, "session_id": session_id}
        )
        return result

    @property
    def current_context(self) -> dict[str, Any]:
        """Return the cached active context without re-running inference."""
        return self._cached_context
