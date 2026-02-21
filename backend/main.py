"""
NodeSense FastAPI Application
Main entry point — CORS, lifespan (graph persistence), REST endpoints, WebSocket.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from schemas import (
    ChatRequest,
    ChatResponse,
    ContextResponse,
    CommunityInfo,
    GraphStatsResponse,
    PageVisitRequest,
)
from graph_service import GraphService
from langgraph_flow import NodeSenseWorkflows
import llm_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Services (module-level singletons) ────────────────────────────────────────

graph_service = GraphService()
workflows: NodeSenseWorkflows | None = None


# ── Lifespan ──────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: load graph from disk.  Shutdown: persist graph."""
    global workflows

    logger.info("Loading knowledge graph from %s", settings.GRAPH_PERSIST_PATH)
    graph_service.load()
    # Re-run community detection on existing graph
    if graph_service.graph.number_of_nodes() > 0:
        graph_service.detect_communities()

    workflows = NodeSenseWorkflows(graph_service)
    logger.info(
        "NodeSense backend ready  (%d nodes, %d edges)",
        graph_service.graph.number_of_nodes(),
        graph_service.graph.number_of_edges(),
    )

    yield  # ── app is running ──

    logger.info("Persisting knowledge graph …")
    graph_service.save()
    logger.info("Shutdown complete.")


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="NodeSense",
    description="Contextually-aware browser agent backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "chrome-extension://*",
        "http://localhost:*",
        "http://127.0.0.1:*",
        "*",  # dev convenience — tighten for production
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── REST Endpoints ────────────────────────────────────────────────────────────


@app.get("/")
async def root():
    return {"service": "NodeSense", "status": "running"}


@app.post("/api/analyze", response_model=ContextResponse)
async def analyze_page(req: PageVisitRequest):
    """
    Process a page visit:
    extract entities → update graph → detect communities → Bayesian inference.
    Returns the inferred active context.
    """
    result = await workflows.analyze_page(
        url=req.url,
        title=req.title,
        content=req.content,
        timestamp=req.timestamp,
        keywords=req.keywords,
        summary=req.summary,
    )

    ctx = result.get("active_context", {})
    all_tasks = ctx.get("all_tasks", [])

    return ContextResponse(
        active_task=ctx.get("task_label", "Exploring"),
        keywords=ctx.get("keywords", []),
        confidence=ctx.get("confidence", 0.0),
        communities=[
            CommunityInfo(
                label=t.get("label", ""),
                keywords=t.get("keywords", []),
                size=t.get("size", 0),
                probability=t.get("probability", 0.0),
            )
            for t in all_tasks
        ],
    )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """
    Handle a user chat query.
    Injects the current browsing context into the LLM prompt.
    """
    result = await workflows.chat(query=req.query, session_id=req.session_id)
    ctx = workflows.current_context

    return ChatResponse(
        response=result.get("response", ""),
        context_used=ctx.get("task_label", ""),
    )


@app.get("/api/context", response_model=ContextResponse)
async def get_context():
    """Return the current active context without triggering a new analysis."""
    ctx = workflows.current_context
    all_tasks = ctx.get("all_tasks", [])

    return ContextResponse(
        active_task=ctx.get("task_label", "Exploring"),
        keywords=ctx.get("keywords", []),
        confidence=ctx.get("confidence", 0.0),
        communities=[
            CommunityInfo(
                label=t.get("label", ""),
                keywords=t.get("keywords", []),
                size=t.get("size", 0),
                probability=t.get("probability", 0.0),
            )
            for t in all_tasks
        ],
    )


@app.get("/api/graph", response_model=GraphStatsResponse)
async def get_graph():
    """Return graph statistics and serialized node/edge data."""
    data = graph_service.to_serializable()
    return GraphStatsResponse(**data)


@app.post("/api/graph/reset")
async def reset_graph():
    """Clear the entire knowledge graph and reset inference state."""
    graph_service.graph.clear()
    graph_service._communities = []
    graph_service._community_labels = []
    graph_service.save()

    # Reset the workflows' cached context
    workflows._cached_context = {
        "task_label": "Exploring",
        "keywords": [],
        "confidence": 0.0,
        "all_tasks": [],
    }
    workflows.inferrer = __import__("bayesian").BayesianTaskInferrer()

    logger.info("Knowledge graph reset")
    return {"status": "ok", "message": "Graph cleared"}


@app.get("/api/stats")
async def get_stats():
    """Return diagnostics: graph stats + LLM rate limiter status."""
    return {
        "graph": graph_service.get_stats(),
        "llm": llm_service.get_llm_stats(),
    }


@app.get("/api/pipeline/events")
async def get_pipeline_events():
    """Return recent pipeline execution events for the Visualize tab."""
    return {
        "runs": workflows.pipeline_events,
    }


# ── WebSocket (optional real-time channel) ────────────────────────────────────


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """
    Optional WebSocket for streaming updates.
    Supports two message types:
      { "type": "page_visit", ... }  → runs analysis pipeline
      { "type": "chat", "query": ... }  → runs chat pipeline
    """
    await ws.accept()
    logger.info("WebSocket client connected")

    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type", "")

            if msg_type == "page_visit":
                result = await workflows.analyze_page(
                    url=data.get("url", ""),
                    title=data.get("title", ""),
                    content=data.get("content", ""),
                    timestamp=data.get("timestamp", time.time()),
                    keywords=data.get("keywords"),
                    summary=data.get("summary"),
                )
                ctx = result.get("active_context", {})
                await ws.send_json({"type": "context_update", "context": ctx})

            elif msg_type == "chat":
                result = await workflows.chat(
                    query=data.get("query", ""),
                    session_id=data.get("session_id"),
                )
                await ws.send_json(
                    {
                        "type": "chat_response",
                        "response": result.get("response", ""),
                        "context": workflows.current_context,
                    }
                )
            else:
                await ws.send_json({"type": "error", "message": f"Unknown type: {msg_type}"})

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception as e:
        logger.error("WebSocket error: %s", e)
        await ws.close()


# ── Run ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.BACKEND_HOST,
        port=settings.BACKEND_PORT,
        reload=True,
    )
