# NodeSense ⬡

> Contextually-aware browser agent that passively builds a knowledge graph of your browsing and uses Bayesian inference to determine what you're working on — injecting that context into every LLM interaction.

NodeSense observes your browsing, extracts topic keywords (on-device via Gemini Nano when available), builds a **NetworkX knowledge graph**, detects task clusters via **Louvain community detection**, and computes $P(\text{Task}|\text{Browsing})$ using **Bayesian inference**. That inferred context is then injected into chat responses powered by **Gemini 2.5 Flash** via GraphRAG.

## Architecture

```
Chrome Extension (Chrome MV3 · React · Vite)      Python Backend (FastAPI · LangGraph)
┌─────────────────────────────────────┐            ┌──────────────────────────────────────┐
│  Content Script  →  scrapes page    │            │  LangGraph PageAnalysis pipeline     │
│  Service Worker  →  serial queue,   │──POST /api/analyze──▶  1. Skip extract if Nano   │
│                     Gemini Nano     │            │             keywords provided        │
│                     extraction,     │            │  2. Update NetworkX graph            │
│                     port broker     │            │  3. Louvain community detection      │
│  Side Panel      →  3-tab React UI  │◀──JSON context ─────  4. Bayesian P(Task|Browsing)│
│    · Context tab                    │            │  5. GraphRAG chat (Flash)            │
│    · Graph tab (canvas force layout)│            └──────────────────────────────────────┘
│    · Visualize tab (pipeline events)│
└─────────────────────────────────────┘
```

## Two-Tier AI Strategy

| Role | Model | Where |
|------|-------|-------|
| **Keyword extraction** | Gemini Nano (Chrome Built-in AI) | On-device, in the service worker |
| **Extraction fallback** | Heuristic (title + content frequency) | Backend — no API call |
| **Contextual chat** | Gemini 2.5 Flash | Server-side, via Gemini API |

Gemini Nano is initialized once at service worker startup. Each extraction clones the base session (stateless, JSON Schema `responseConstraint` for structured `string[]` output), then destroys the clone. If Nano is unavailable, the extension sends raw page content and the backend applies a heuristic fallback — **Gemini 2.5 Flash is never used for extraction**.

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Extension** | Chrome MV3, React 18, Vite | Side panel UI, content scraping, message passing |
| **On-device AI** | Chrome Built-in AI — Gemini Nano | Keyword extraction (Prompt API + `LanguageModel.create()`) |
| **Backend** | FastAPI, Uvicorn | REST API + WebSocket server |
| **Orchestration** | LangGraph | Two `StateGraph` workflows: page analysis & chat |
| **Knowledge Graph** | NetworkX | In-memory heterogeneous weighted graph with temporal decay |
| **Math Engine** | Louvain + Bayesian inference | Modularity-based community detection, posterior task probability |
| **Chat LLM** | Gemini 2.5 Flash (API) | GraphRAG-enriched contextual responses; 429 → 60s cooldown |
| **Persistence** | Python `pickle` | Graph survives restarts (`graph.pkl`) |

## Quick Start

### Prerequisites

- Python ≥ 3.11, Node.js ≥ 18
- A [Google AI Studio](https://aistudio.google.com/) API key (for chat)
- Chrome with the following flags enabled for Gemini Nano (optional but recommended):
  - `chrome://flags/#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
  - `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**

### 1. Backend

```bash
cd backend
python3 -m venv ../.venv && source ../.venv/bin/activate
pip install -r requirements.txt

# Set your Gemini API key
echo "GEMINI_API_KEY=your-key-here" > ../.env

# Start the server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The server loads the persisted graph from `graph.pkl` on startup (if it exists) and saves it again on shutdown. Delete `graph.pkl` to start fresh.

### 2. Extension

```bash
cd extension
npm install
npm run build   # outputs to extension/dist/
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder (not `dist/`)
4. Click the NodeSense icon → side panel opens

The status bar at the top of the side panel shows live badges:
- **`NANO`** — Gemini Nano is active (on-device extraction)
- **`HEURISTIC`** — Nano unavailable; backend heuristic fallback in use
- **`FLASH`** — Gemini 2.5 Flash is the active chat model

### 3. Test the API

```bash
# Health check
curl http://localhost:8000/

# Submit a page visit (with pre-extracted keywords from Nano)
curl -X POST http://localhost:8000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://react.dev/learn","title":"React Docs","keywords":["react","hooks","components"],"timestamp":'$(date +%s)'}'

# Submit a page visit (raw content — backend will use heuristic extraction)
curl -X POST http://localhost:8000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://react.dev/learn","title":"React Docs","content":"React components let you build UIs...","timestamp":'$(date +%s)'}'

# Current inferred context
curl http://localhost:8000/api/context

# Chat with context injection
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"query":"What am I working on?"}'

# Graph stats + serialized nodes/edges
curl http://localhost:8000/api/graph

# Diagnostics (graph stats + LLM rate limiter status)
curl http://localhost:8000/api/stats

# Recent pipeline execution events (used by the Visualize tab)
curl http://localhost:8000/api/pipeline/events

# Reset the knowledge graph
curl -X POST http://localhost:8000/api/graph/reset
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `POST` | `/api/analyze` | Full pipeline: extract → graph update → communities → Bayesian inference |
| `POST` | `/api/chat` | GraphRAG-enriched chat query (Gemini 2.5 Flash) |
| `GET` | `/api/context` | Current inferred task context (no re-analysis) |
| `GET` | `/api/graph` | Graph stats + serialized nodes/edges |
| `POST` | `/api/graph/reset` | Clear the knowledge graph and reset inference state |
| `GET` | `/api/stats` | Diagnostics: graph stats + LLM rate limiter status |
| `GET` | `/api/pipeline/events` | Recent LangGraph pipeline run events |
| `WS` | `/ws` | WebSocket — `page_visit` and `chat` message types |

## How It Works

1. **Content Script** scrapes page title + body text at `document_idle` (strips noisy DOM elements, runs in ISOLATED world)
2. **Service Worker** receives the `PAGE_CONTENT` message, debounces (5s same-URL, 3s min interval), then runs a serial processing queue:
   - **Nano available** → extracts keywords on-device → sends `{url, title, keywords, timestamp}` to `/api/analyze`
   - **Nano unavailable** → sends `{url, title, content, timestamp}` → backend applies heuristic fallback
3. **LangGraph `PageAnalysisState` pipeline** runs:
   - **Entity Extraction**: skipped if `keywords` already in state; otherwise uses heuristic `_fallback_extract`
   - **Graph Update**: keyword nodes + page nodes created; co-occurrence edges weighted and incremented
   - **Temporal Decay**: edge weights decay via $w(t) = w_0 \cdot e^{-\lambda \Delta t}$ (configurable $\lambda$)
   - **Community Detection**: Louvain algorithm maximises modularity $Q$ to find topic clusters
   - **Bayesian Inference**: $P(\text{Task}|\text{Evidence}) \propto P(\text{Evidence}|\text{Task}) \cdot P(\text{Task})$ with Laplace smoothing; cold-start guard returns "Exploring" when confidence < 0.25
4. **Active context** (top community label, keywords, confidence, all tasks) is returned and cached
5. **Chat queries** run the `ChatState` pipeline: retrieve GraphRAG context → build prompt with browsing trajectory → call Gemini 2.5 Flash

See [MATH.md](MATH.md) for the full mathematical foundations.

## Project Structure

```
nodesense/
├── backend/
│   ├── main.py              # FastAPI app — lifespan, CORS, all endpoints, WebSocket
│   ├── config.py            # Settings class loading from env / .env file
│   ├── schemas.py           # Pydantic v2 request/response models
│   ├── graph_service.py     # NetworkX graph CRUD, temporal decay, Louvain communities, pruning
│   ├── bayesian.py          # BayesianTaskInferrer — P(Task|Evidence) with Laplace smoothing
│   ├── llm_service.py       # Gemini 2.5 Flash for chat; heuristic fallback for extraction
│   ├── langgraph_flow.py    # Two StateGraph workflows: PageAnalysisState + ChatState
│   ├── graph.pkl            # Persisted graph (auto-created; delete to reset)
│   └── requirements.txt
├── extension/
│   ├── manifest.json        # Chrome MV3 manifest (sidePanel, tabs, scripting, storage)
│   ├── service-worker.js    # Serial queue, Gemini Nano init/clone/destroy, port broker
│   ├── content-script.js    # IIFE page scraper (ISOLATED world, document_idle)
│   ├── sidepanel.html       # Vite HTML entry point
│   ├── vite.config.js       # base: './' required for extension asset paths
│   ├── package.json
│   ├── public/icons/        # Extension icons (16, 48, 128 px)
│   ├── dist/                # Built output loaded by Chrome
│   └── src/
│       ├── App.jsx           # Root — tab state (context / graph / visualize), chat state
│       ├── index.css
│       ├── main.jsx
│       ├── components/
│       │   ├── StatusBar.jsx     # NANO / HEURISTIC / FLASH badges, connection indicator
│       │   ├── ContextView.jsx   # Active task, confidence, community list
│       │   ├── GraphView.jsx     # Custom canvas force-directed graph layout (no D3)
│       │   ├── DataFlowView.jsx  # Pipeline execution events (Visualize tab)
│       │   └── ChatPanel.jsx     # Chat UI; history persisted to chrome.storage.local
│       └── hooks/
│           └── useBackend.js     # Port lifecycle, auto-reconnect, typed message dispatch
├── docs/
│   ├── ai-strategy.md
│   ├── context-engine.md
│   ├── data-flow.md
│   ├── knowledge-graph.md
│   └── demo-script.md
├── MATH.md                  # Mathematical foundations
└── README.md
```

## Extension ↔ Backend Message Flow

```
Content Script ──PAGE_CONTENT──▶ Service Worker ──Nano extract──▶ POST /api/analyze ──▶ FastAPI
                                       │           (keywords)                               │
Side Panel ◀──port messages──── Service Worker ◀──────────── JSON context/chat response ───┘
```

The service worker is the single communication hub. The side panel never calls the backend directly.

| Direction | Message Type | Payload |
|-----------|-------------|---------|
| Content → SW | `PAGE_CONTENT` | `{title, content, url}` |
| SW → Panel | `CONTEXT_UPDATE` | `{context: ContextResponse}` |
| SW → Panel | `CHAT_RESPONSE` | `{response, contextUsed}` |
| SW → Panel | `GRAPH_DATA` | graph nodes + edges |
| SW → Panel | `INIT_STATE` | initial context on port connect |
| SW → Panel | `NANO_STATUS` | `{nanoAvailable: boolean}` |
| Panel → SW | `CHAT_QUERY` | `{query, sessionId}` |
| Panel → SW | `GET_CONTEXT` | `{}` |
| Panel → SW | `GET_GRAPH` | `{}` |

## Configuration

All variables are read from `.env` at the project root (loaded by `python-dotenv`):

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Google Gemini API key (required for chat) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model used exclusively for chat |
| `BACKEND_HOST` | `0.0.0.0` | Server bind host |
| `BACKEND_PORT` | `8000` | Server port |
| `GRAPH_PERSIST_PATH` | `graph.pkl` | Path to the pickled graph file |
| `MAX_GRAPH_NODES` | `500` | Node count at which pruning triggers |
| `DECAY_RATE` | `0.01` | Temporal decay rate λ (per hour) |
| `LAPLACE_SMOOTHING` | `0.1` | Bayesian prior smoothing α |
| `COMMUNITY_RESOLUTION` | `1.0` | Louvain resolution (higher → smaller clusters) |
| `COMMUNITY_SEED` | `42` | Random seed for reproducible Louvain runs |
| `MAX_CONTENT_LENGTH` | `8000` | Max chars of page content sent to backend |
| `MAX_KEYWORDS_PER_PAGE` | `12` | Max keywords extracted per page |
| `MAX_CONTEXT_PAGES` | `10` | Pages included in GraphRAG context |
| `MAX_CONTEXT_SNIPPET_LENGTH` | `3000` | Max chars of context injected into chat prompt |
| `MAX_TRAJECTORY_PAGES` | `8` | Pages shown in browsing trajectory |
| `MAX_DEEP_CONTENT_PAGES` | `4` | Pages with full content sent to chat LLM |
| `MAX_DEEP_CONTENT_LENGTH` | `2000` | Max chars per page in deep content |
