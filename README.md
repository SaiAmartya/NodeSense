# NodeSense ⬡

> Contextually-aware browser agent that builds a knowledge graph of your browsing to provide intelligent, zero-context assistance.

NodeSense passively observes your browsing, extracts topic keywords, builds a **NetworkX knowledge graph**, detects task clusters via **Louvain community detection**, and uses **Bayesian inference** to determine what you're working on, then injects that context into every LLM interaction.

## Architecture

```
Chrome Extension (React + Vite)          Python Backend (FastAPI)
┌──────────────────────────┐             ┌──────────────────────────┐
│ Content Script → scrapes │──HTTP POST──│ LangGraph Orchestrator   │
│ Service Worker → routes  │             │  1. Entity Extraction    │
│ Side Panel → chat UI     │             │  2. Graph Update (NX)    │
│ Gemini Nano (optional)   │             │  3. Louvain Communities  │
└──────────────────────────┘             │  4. Bayesian Inference   │
                                         │  5. GraphRAG Chat        │
                                         └──────────────────────────┘
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Extension** | Chrome MV3, React, Vite | Side panel UI, content scraping, message passing |
| **Local AI** | Chrome Built-in AI (Gemini Nano) | On-device summarization (when available) |
| **Backend** | FastAPI, Uvicorn | REST API + WebSocket server |
| **Orchestration** | LangGraph | Stateful workflow: extract → update → detect → infer |
| **Knowledge Graph** | NetworkX | In-memory weighted graph with temporal decay |
| **Math Engine** | Louvain + Bayesian inference | Community detection, P(Task\|Browsing) computation |
| **LLM Fallback** | Gemini API (gemini-2.0-flash) | Entity extraction + contextual chat responses |

## Quick Start

### 1. Backend

```bash
cd backend
source ../.venv/bin/activate  # or create: python3 -m venv ../.venv && source ../.venv/bin/activate
pip install -r requirements.txt

# Set your Gemini API key
echo "GEMINI_API_KEY=your-key-here" > ../.env

# Start the server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 2. Extension

```bash
cd extension
npm install
npm run build
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click the NodeSense icon → side panel opens

### 3. Test the API

```bash
# Check server health
curl http://localhost:8000/

# Submit a page visit
curl -X POST http://localhost:8000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://react.dev/learn","title":"React Docs","content":"React components...","timestamp":'$(date +%s)'}'

# Check inferred context
curl http://localhost:8000/api/context

# Chat with context
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"query":"What am I working on?"}'

# Inspect the knowledge graph
curl http://localhost:8000/api/graph
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `POST` | `/api/analyze` | Process a page visit (full pipeline) |
| `POST` | `/api/chat` | Context-enriched chat query |
| `GET` | `/api/context` | Current inferred task context |
| `GET` | `/api/graph` | Graph stats + serialized nodes/edges |
| `WS` | `/ws` | WebSocket for real-time updates |

## How It Works

1. **Content Script** scrapes page title + body text on every page load
2. **Service Worker** optionally summarizes via Gemini Nano, then POSTs to backend
3. **LangGraph pipeline** runs:
   - **Entity Extraction**: LLM (or fallback) extracts 3-5 topic keywords
   - **Graph Update**: Keywords become nodes; co-occurrence creates weighted edges
   - **Temporal Decay**: Old edges decay via $w(t) = w_0 \cdot e^{-\lambda \Delta t}$
   - **Community Detection**: Louvain algorithm finds topic clusters
   - **Bayesian Inference**: $P(\text{Task}|\text{Browsing}) \propto P(\text{Browsing}|\text{Task}) \times P(\text{Task})$
4. **Active Context** (top community + keywords) is returned to the extension
5. **Chat queries** are enriched with this context before hitting the LLM

See [MATH.md](MATH.md) for full mathematical foundations.

## Project Structure

```
nodesense/
├── backend/
│   ├── main.py              # FastAPI app, CORS, endpoints
│   ├── config.py            # Settings from .env
│   ├── schemas.py           # Pydantic request/response models
│   ├── graph_service.py     # NetworkX graph CRUD + decay + communities
│   ├── bayesian.py          # Bayesian task inference engine
│   ├── llm_service.py       # Gemini API wrapper + fallback
│   ├── langgraph_flow.py    # LangGraph workflow definitions
│   └── requirements.txt
├── extension/
│   ├── manifest.json        # Chrome MV3 manifest
│   ├── service-worker.js    # Background script (message broker + Nano AI)
│   ├── content-script.js    # Page content scraper
│   ├── sidepanel.html       # Vite entry point
│   ├── src/
│   │   ├── App.jsx          # Root component
│   │   ├── components/
│   │   │   ├── StatusBar.jsx
│   │   │   ├── ContextView.jsx
│   │   │   └── ChatPanel.jsx
│   │   └── hooks/
│   │       └── useBackend.js
│   ├── vite.config.js
│   └── package.json
├── MATH.md                  # Mathematical foundations documentation
└── README.md
```

## Configuration

Environment variables (set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model for extraction/chat |
| `DECAY_RATE` | `0.01` | Edge weight decay rate (per hour) |
| `LAPLACE_SMOOTHING` | `0.1` | Bayesian prior smoothing |
| `COMMUNITY_RESOLUTION` | `1.0` | Louvain resolution (>1 = smaller clusters) |
| `MAX_GRAPH_NODES` | `500` | Prune threshold |
| `BACKEND_PORT` | `8000` | Server port |
