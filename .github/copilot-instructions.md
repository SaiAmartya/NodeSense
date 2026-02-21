# NodeSense — Copilot Instructions

## Architecture Overview

NodeSense is a Chrome extension + Python backend that passively builds a knowledge graph from browsing activity and uses Bayesian inference to determine what task the user is working on.

**Two-tier AI strategy:**
- **Gemini Nano** (Chrome Built-in AI, on-device) — handles keyword/entity extraction cheaply and fast to keep the knowledge graph updated
- **Gemini 2.5 Flash** (server-side API) — handles contextual chat responses, empowered by GraphRAG context injection

**Data flow:** Content script scrapes page → service worker extracts keywords via Gemini Nano → POSTs keywords + metadata to backend → LangGraph pipeline (skip extraction if keywords provided → update NetworkX graph → Louvain community detection → Bayesian posterior computation) → inferred context cached & returned → side panel UI updates.

Two independently deployable components:
- **`backend/`** — FastAPI server, all state lives here (in-memory NetworkX graph, persisted to `graph.pkl` via pickle)
- **`extension/`** — Chrome MV3 extension (React + Vite side panel, vanilla JS content script & service worker)

## AI Extraction Strategy

The service worker initializes Gemini Nano via the Chrome Prompt API (`LanguageModel.create()`) on startup. For each page visit:
1. **Nano available:** Extract keywords on-device → send `{url, title, keywords, timestamp}` to backend (no raw content needed)
2. **Nano unavailable:** Send `{url, title, content, timestamp}` → backend uses heuristic fallback extraction (`_fallback_extract` in `llm_service.py`)

The backend's `_node_extract_entities` in `langgraph_flow.py` checks if `keywords` are already in the state and skips extraction if so. Gemini 2.5 Flash is **never** used for extraction — only for chat via `generate_contextual_response()`.

Key Nano implementation details in `service-worker.js`:
- Base session created with a system prompt for keyword extraction
- Each extraction clones the base session (stateless, avoids context overflow)
- Clones are destroyed after each extraction
- `responseConstraint` with JSON Schema ensures structured `string[]` output
- On session failure, auto-reinitializes in background

## Backend (`backend/`)

- **Entry point:** `main.py` — FastAPI app with lifespan (loads/saves graph on start/shutdown), REST endpoints, and WebSocket
- **Orchestration:** `langgraph_flow.py` — Two `StateGraph` workflows using LangGraph:
  - `PageAnalysisState`: extract → update_graph → detect_communities → infer_task
  - `ChatState`: retrieve_context → generate_response
- **Graph:** `graph_service.py` — NetworkX `nx.Graph` with two node types (`page:<url>`, `kw:<term>`), weighted edges, temporal decay (`w(t) = w₀·e^(-λΔt)`), Louvain communities, and pruning at `MAX_GRAPH_NODES`
- **Inference:** `bayesian.py` — `BayesianTaskInferrer` computes `P(Task|Evidence)` with Laplace-smoothed priors/likelihoods; cold-start guard returns "Exploring" when confidence < 0.25
- **LLM:** `llm_service.py` — Gemini 2.5 Flash for chat ONLY. Heuristic fallback extraction for when Nano is unavailable. 429 errors trigger a 60s cooldown
- **Config:** `config.py` — Plain `Settings` class reading from env vars / `.env` file (not Pydantic BaseSettings)
- **Schemas:** `schemas.py` — Pydantic v2 models; `PageVisitRequest` has optional `keywords` field (populated by Nano); `CommunityInfo` is defined after `ContextResponse` so `model_rebuild()` is called at module level

### Key conventions
- Services are **module-level singletons** (`graph_service`, `workflows` in `main.py`); no dependency injection
- Graph nodes use string IDs with type prefixes: `"page:<url>"` and `"kw:<term>"`
- Edge data has `base_weight`, `weight` (decayed), `last_active`, `created`
- All LangGraph node functions are `async` methods on `NodeSenseWorkflows`, returning dicts that merge into the state
- Gemini API is used ONLY for chat — never for extraction

### Running the backend
```bash
cd backend
source ../.venv/bin/activate
pip install -r requirements.txt
echo "GEMINI_API_KEY=<key>" > ../.env
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Extension (`extension/`)

- **Content script** (`content-script.js`) — IIFE, runs at `document_idle`, strips noisy DOM elements, sends `PAGE_CONTENT` message to service worker. Runs in ISOLATED world (no page JS access)
- **Service worker** (`service-worker.js`) — Message broker with a **serial processing queue** (`drainQueue`) and debounce (5s same-URL, 3s min interval). Initializes Gemini Nano for on-device keyword extraction. Communicates with side panel via `chrome.runtime.connect` ports (named `"nodesense-sidepanel"`)
- **Side panel** — React app built with Vite (`base: './'` is critical for extension asset paths). Entry at `sidepanel.html`, output to `dist/`
- **Message types:** `PAGE_CONTENT` (content→SW), `CHAT_QUERY`/`GET_CONTEXT`/`GET_GRAPH` (panel→SW), `CONTEXT_UPDATE`/`CHAT_RESPONSE`/`GRAPH_DATA`/`INIT_STATE`/`NANO_STATUS` (SW→panel)
- **`useBackend` hook** — Manages port lifecycle with auto-reconnect (2s/3s delays). Uses `listenersRef` Map for typed message dispatch. Handles `NANO_STATUS` updates for live Nano availability

### Key conventions
- CSS class naming follows BEM: `status-bar__dot`, `context-view__header`, `tab-bar__tab--active`
- Chat history persisted to `chrome.storage.local` (last 50 messages); session context uses `chrome.storage.session`
- `GraphView` implements a custom force-directed layout on Canvas (no D3/vis dependency)
- The Vite build output (`dist/`) is what gets loaded as the unpacked extension, alongside root-level `content-script.js`, `service-worker.js`, and `manifest.json`
- Build with `cd extension && npm run build`; then load `extension/` folder in `chrome://extensions`
- StatusBar badges: `NANO` (on-device extraction active), `HEURISTIC` (Nano unavailable), `FLASH` (server chat model)

## Cross-Component Communication

```
Content Script ──PAGE_CONTENT──→ Service Worker ──Nano extract──→ POST /api/analyze──→ FastAPI
                                       │          (keywords)                              │
Side Panel ←──port messages──── Service Worker ←──────JSON response──────── LangGraph flow
```

The service worker is the single communication hub. The side panel never calls the backend directly — all requests route through the service worker port.

## Environment & Config

- Python venv lives at project root: `../.venv` (relative to `backend/`)
- `.env` file at project root, loaded by `python-dotenv` in `config.py`
- Key tuning params: `DECAY_RATE` (temporal decay λ), `COMMUNITY_RESOLUTION` (Louvain granularity), `LAPLACE_SMOOTHING` (Bayesian prior), `MAX_GRAPH_NODES` (prune threshold)
- Graph persists to `graph.pkl` in `backend/` by default — delete it to reset state
- Gemini Nano requires Chrome flags on localhost: `chrome://flags/#optimization-guide-on-device-model` and `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` (Enabled)

## When Modifying Code

- Adding a new LangGraph node: add the async method to `NodeSenseWorkflows`, register with `builder.add_node()`, wire edges in `_build_*_workflow()`
- Adding a new API endpoint: define Pydantic models in `schemas.py`, add route in `main.py`, delegate to `workflows` or `graph_service`
- Adding a new message type: update `handleSidePanelMessage` switch in `service-worker.js`, add handler in `useBackend.js` via `onMessage`, update relevant component
- Graph mutations must go through `GraphService` methods to maintain consistent node ID conventions and edge metadata
- Math foundations are documented in `MATH.md` — reference it when modifying inference or community detection logic
- Extraction changes: modify `extractKeywordsWithNano()` in `service-worker.js` (primary) or `_fallback_extract()` in `llm_service.py` (backend fallback). Never add Gemini API calls for extraction
