"""
NodeSense Pydantic Models / Schemas
Defines request/response shapes for all API endpoints.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


# ── Requests ──────────────────────────────────────────────────────────────────


class PageVisitRequest(BaseModel):
    """Payload sent by the extension when a user visits a page."""

    url: str
    title: str
    content: str = Field(
        default="",
        description="Page body text (truncated by the extension to ~3000 chars)",
    )
    timestamp: float = Field(
        description="Unix epoch seconds when the page was visited"
    )


class ChatRequest(BaseModel):
    """Payload sent when the user submits a chat query in the side panel."""

    query: str
    session_id: Optional[str] = None


# ── Responses ─────────────────────────────────────────────────────────────────


class ContextResponse(BaseModel):
    """Current inferred browsing context returned to the extension."""

    active_task: str = Field(
        default="Exploring",
        description="Human-readable label for the inferred task",
    )
    keywords: list[str] = Field(default_factory=list)
    confidence: float = Field(
        default=0.0, ge=0.0, le=1.0, description="Posterior probability"
    )
    communities: list[CommunityInfo] = Field(default_factory=list)


class CommunityInfo(BaseModel):
    """Lightweight representation of a detected community / task cluster."""

    label: str
    keywords: list[str]
    size: int
    probability: float = 0.0


class ChatResponse(BaseModel):
    """Response returned after processing a chat query."""

    response: str
    context_used: str = Field(
        default="",
        description="The active context that was injected into the LLM prompt",
    )


class GraphStatsResponse(BaseModel):
    """High-level statistics about the knowledge graph."""

    node_count: int = 0
    edge_count: int = 0
    community_count: int = 0
    top_keywords: list[str] = Field(default_factory=list)
    nodes: list[dict] = Field(default_factory=list)
    edges: list[dict] = Field(default_factory=list)


# Rebuild ContextResponse now that CommunityInfo is defined
ContextResponse.model_rebuild()
