"""
NodeSense LangGraph Orchestration
Defines two stateful workflows:
  1. Page Analysis  — extract → graph update → community detect → Bayes infer
  2. Chat           — retrieve context → generate response

Each workflow is a compiled LangGraph StateGraph that can be invoked as a
plain Python callable.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Set
from typing_extensions import TypedDict

from langgraph.graph import StateGraph, START, END

from graph_service import GraphService
from bayesian import BayesianTaskInferrer
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
        builder.add_node("update_graph", self._node_update_graph)
        builder.add_node("detect_communities", self._node_detect_communities)
        builder.add_node("infer_task", self._node_infer_task)

        # Wire edges
        builder.add_edge(START, "extract_entities")
        builder.add_edge("extract_entities", "update_graph")
        builder.add_edge("update_graph", "detect_communities")
        builder.add_edge("detect_communities", "infer_task")
        builder.add_edge("infer_task", END)

        return builder.compile()

    async def _node_extract_entities(self, state: PageAnalysisState) -> dict:
        """Node 1: Use LLM to extract topic keywords from page content."""
        keywords = await llm_service.extract_entities(
            content=state.get("content", ""),
            title=state.get("title", ""),
            url=state.get("url", ""),
        )
        return {"keywords": keywords}

    async def _node_update_graph(self, state: PageAnalysisState) -> dict:
        """Node 2: Add the page visit to the NetworkX knowledge graph."""
        self.gs.add_page_visit(
            url=state["url"],
            title=state["title"],
            keywords=state.get("keywords", []),
            timestamp=state.get("timestamp", time.time()),
        )
        # Apply temporal decay on every update
        self.gs.apply_temporal_decay()
        return {}

    async def _node_detect_communities(self, state: PageAnalysisState) -> dict:
        """Node 3: Run Louvain community detection."""
        communities = self.gs.detect_communities()
        return {"communities": communities}

    async def _node_infer_task(self, state: PageAnalysisState) -> dict:
        """Node 4: Bayesian inference to determine the active task."""
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

        # Cache the latest context for chat queries
        self._cached_context = active_context

        return {"posteriors": posteriors, "active_context": active_context}

    # ── Chat Workflow ─────────────────────────────────────────────────────

    def _build_chat_workflow(self):
        builder = StateGraph(ChatState)

        builder.add_node("retrieve_context", self._node_retrieve_context)
        builder.add_node("generate_response", self._node_generate_response)

        builder.add_edge(START, "retrieve_context")
        builder.add_edge("retrieve_context", "generate_response")
        builder.add_edge("generate_response", END)

        return builder.compile()

    async def _node_retrieve_context(self, state: ChatState) -> dict:
        """Fetch the most recent active context from the cache."""
        return {"active_context": self._cached_context}

    async def _node_generate_response(self, state: ChatState) -> dict:
        """Use the Gemini API (with context injection) to answer the user."""
        context = state.get("active_context", self._cached_context)
        query = state.get("query", "")

        response = await llm_service.generate_contextual_response(
            query=query, context=context
        )
        return {"response": response}

    # ── Public API ────────────────────────────────────────────────────────

    async def analyze_page(
        self, url: str, title: str, content: str, timestamp: float | None = None
    ) -> dict[str, Any]:
        """
        Run the full page-analysis pipeline.
        Returns the final state including active_context.
        """
        result = await self.analyze_graph.ainvoke(
            {
                "url": url,
                "title": title,
                "content": content,
                "timestamp": timestamp or time.time(),
            }
        )
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
