# Data Flow

End-to-end data flow from page visit to contextual AI response.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CHROME EXTENSION                         │
│                                                                 │
│  Content Script          Service Worker           Side Panel    │
│  ┌──────────┐           ┌──────────────┐        ┌──────────┐   │
│  │ Scrape   │──PAGE──→  │ Nano Extract │        │ Chat UI  │   │
│  │ DOM text │ CONTENT   │ + Summarize  │        │ Graph    │   │
│  └──────────┘           │ + Queue      │←─port─→│ Context  │   │
│                         └──────┬───────┘        └──────────┘   │
│                                │                                │
└────────────────────────────────┼────────────────────────────────┘
                                 │ HTTP POST
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PYTHON BACKEND                           │
│                                                                 │
│  ┌─────────────────── LangGraph Pipeline ──────────────────┐   │
│  │                                                          │   │
│  │  Page Analysis Workflow:                                 │   │
│  │                                                          │   │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐            │   │
│  │  │ Extract  │──→│ Generate │──→│ Update   │            │   │
│  │  │ Keywords │   │ Summary  │   │ Graph    │            │   │
│  │  └──────────┘   └──────────┘   └────┬─────┘            │   │
│  │                                      │                   │   │
│  │  ┌──────────┐   ┌──────────────────┐ │                  │   │
│  │  │ Infer    │←──│ Detect           │←┘                  │   │
│  │  │ Task +   │   │ Communities      │                    │   │
│  │  │ Enrich   │   │ (Louvain)        │                    │   │
│  │  └──────────┘   └──────────────────┘                    │   │
│  │                                                          │   │
│  │  Chat Workflow:                                          │   │
│  │                                                          │   │
│  │  ┌──────────┐   ┌──────────────┐   ┌──────────────┐    │   │
│  │  │ Retrieve │──→│ Assemble     │──→│ Generate     │    │   │
│  │  │ Context  │   │ Deep Context │   │ Response     │    │   │
│  │  └──────────┘   └──────────────┘   └──────────────┘    │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────────┐        │
│  │ NetworkX     │  │ Bayesian   │  │ Gemini Flash     │        │
│  │ Graph        │  │ Inferrer   │  │ (chat only)      │        │
│  └──────────────┘  └────────────┘  └──────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

## Phase 1: Content Extraction (Extension)

### Step 1.1: DOM Scraping
**Component:** `content-script.js`  
**Trigger:** Page load (`document_idle` + 500ms delay)

The content script:
1. Clones the page's `<body>` element
2. Strips noisy elements (scripts, styles, nav, footer, ads, sidebars)
3. Extracts text content, collapses whitespace
4. Truncates to 3000 characters
5. Sends `PAGE_CONTENT` message to the service worker

### Step 1.2: Keyword Extraction
**Component:** `service-worker.js`  
**Method:** `extractKeywordsWithNano()` or heuristic fallback

If Gemini Nano is available:
- Clone the base Nano session (stateless)
- Prompt with title + truncated content (1500 chars)
- Parse structured JSON response → `string[]` of keywords
- Destroy the clone

If Nano is unavailable:
- Raw content is sent to the backend for heuristic extraction

### Step 1.3: Backend Submission
**Component:** `service-worker.js`  
**Method:** `processPageVisit()` → `backendPost("/api/analyze")`

The payload sent to the backend:

```json
{
  "url": "https://react.dev/learn/hooks",
  "title": "React Docs - Hooks Guide",
  "content": "First 500 chars of page content...",
  "keywords": ["react", "hooks", "useState", "useEffect"],
  "timestamp": 1740100000.0
}
```

**Key change:** Content is now always sent (even with Nano keywords), truncated to 500 chars. This enables backend summary generation.

## Phase 2: Page Analysis Pipeline (Backend)

### Step 2.1: Entity Extraction
**LangGraph node:** `extract_entities`

- If `keywords` field is populated (from Nano): use directly, skip extraction
- If not: run heuristic extraction on the content (title words + frequency analysis)

### Step 2.2: Summary Generation
**LangGraph node:** `generate_summary`

- If a `summary` field was provided: use directly
- If not: generate heuristically from title + content
  - Extract first 1-2 coherent sentences from the content
  - Produce a concise description (max 200 chars)
- Also prepare a `content_snippet` (first 500 chars) for storage

### Step 2.3: Graph Update
**LangGraph node:** `update_graph`

Updates the NetworkX knowledge graph:
1. **Upsert page node** with title, summary, content_snippet, visit count, timestamps
2. **Upsert keyword nodes** with frequency, page references
3. **Create/strengthen page↔keyword edges** (association)
4. **Create/strengthen keyword↔keyword edges** (co-occurrence)
5. **Apply temporal decay** to all edges: `w(t) = w₀ × e^(-λΔt)`
6. **Prune** edges below 0.01 weight and resulting orphan nodes
7. **Prune** lowest-value nodes if graph exceeds MAX_GRAPH_NODES

### Step 2.4: Community Detection
**LangGraph node:** `detect_communities`

Runs Louvain community detection on the graph:
- Partitions nodes into communities (dense clusters)
- Labels each community by its top keyword
- Deterministic (seed=42) for stable results

### Step 2.5: Task Inference + Context Enrichment
**LangGraph node:** `infer_task`

**Bayesian Inference:**
1. Compute prior P(Task_i) from community edge weights
2. Compute likelihood P(Evidence|Task_i) from keyword overlap
3. Compute posterior P(Task_i|Evidence) via Bayes' rule
4. Select the top community as the active task

**Context Enrichment:**
After inference, `_enrich_context()` assembles deep context:
1. **Browsing trajectory** — Recent pages with summaries, keywords, temporal distance
2. **Community context** — Pages and keyword relationships in the active cluster
3. **Cross-community bridges** — Keywords connecting different task areas

### Step 2.6: Response
The enriched context is:
- Cached for subsequent chat queries
- Returned to the extension as the API response
- Broadcast to connected side panels via port messaging

## Phase 3: Chat Response (On User Query)

### Step 3.1: Context Retrieval
**LangGraph node:** `retrieve_context`

Fetches the cached enriched context from the last page analysis.

### Step 3.2: Deep Context Assembly
**LangGraph node:** `assemble_deep_context`

Re-enriches the cached context with fresh graph data:
- Updated browsing trajectory (in case new pages were visited)
- Fresh community context
- Current cross-community bridges

### Step 3.3: Prompt Construction
**Function:** `build_context_block()`

Transforms the enriched context dict into structured prompt sections:
- `== ACTIVE TASK ==`
- `== RECENT BROWSING TRAJECTORY ==`
- `== ACTIVE TASK CLUSTER ==`
- `== TOPIC RELATIONSHIPS ==`
- `== CROSS-TOPIC CONNECTIONS ==`
- `== ALL DETECTED TASKS ==`

Empty sections are omitted.

### Step 3.4: Response Generation
**LangGraph node:** `generate_response`

Sends the system prompt (with context block) + user query to Gemini 2.5 Flash.
Falls back to a context-aware template response if the API is unavailable.

## Communication Patterns

### Extension Internal
```
Content Script ──chrome.runtime.sendMessage──→ Service Worker
Side Panel     ←──chrome.runtime.connect port──→ Service Worker
```

### Extension ↔ Backend
```
Service Worker ──HTTP POST /api/analyze──→ FastAPI
Service Worker ──HTTP POST /api/chat──→ FastAPI  
Service Worker ──HTTP GET /api/context──→ FastAPI
Service Worker ──HTTP GET /api/graph──→ FastAPI
```

### Message Types

| Direction | Type | Payload |
|-----------|------|---------|
| Content → SW | `PAGE_CONTENT` | `{url, title, content, timestamp}` |
| SW → Panel | `CONTEXT_UPDATE` | `{context: ContextResponse}` |
| SW → Panel | `CHAT_RESPONSE` | `{response, contextUsed}` |
| SW → Panel | `GRAPH_DATA` | `{nodes, edges, stats}` |
| SW → Panel | `INIT_STATE` | `{context, nanoAvailable}` |
| SW → Panel | `NANO_STATUS` | `{nanoAvailable}` |
| Panel → SW | `CHAT_QUERY` | `{query, sessionId}` |
| Panel → SW | `GET_CONTEXT` | `{}` |
| Panel → SW | `GET_GRAPH` | `{}` |

## State Ownership

| State | Owner | Persistence |
|-------|-------|-------------|
| Knowledge graph | `GraphService` (backend) | `graph.pkl` on disk |
| Active context cache | `NodeSenseWorkflows` (backend) | In-memory only |
| Bayesian posteriors | `BayesianTaskInferrer` (backend) | Computed per analysis |
| Chat history | Extension `chrome.storage.local` | Last 50 messages |
| Session context | Extension `chrome.storage.session` | Per browser session |
| Nano session | Service worker | In-memory, re-created on restart |
