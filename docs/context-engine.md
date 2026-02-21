# Context Engine

How NodeSense transforms raw graph data into rich, structured context for the AI.

---

## The Problem

Consider a typical knowledge graph query result: the user's active community contains keywords `["react", "hooks", "state", "useEffect", "components"]` with 87% confidence. 

If this is all the AI receives, it can only say generic things like "You're working on React development." It can't reference specific pages, understand the user's progression, or connect concepts meaningfully.

## The Solution: Deep Context Assembly

NodeSense's context engine operates in two phases:

1. **Retrieval** — Probabilistic methods (Louvain + Bayesian inference) identify *which* nodes are relevant
2. **Enrichment** — Graph traversal + node attributes assemble *comprehensive* context from those nodes

The key insight is that these are complementary concerns. Community detection and Bayesian posteriors are excellent at finding the right cluster of nodes. But the *usefulness* of that cluster depends entirely on how much semantic information each node carries.

## Context Layers

The assembled context has five structured layers, each providing a different dimension of understanding:

### Layer 1: Active Task Identity

```
Task: React Development
Confidence: 87%
Core topics: react, hooks, state, useEffect, components
```

The baseline — which task cluster is most active, and its defining keywords. This comes directly from Bayesian inference over Louvain communities.

### Layer 2: Browsing Trajectory (with Deep Content)

```
1. "React Docs - useEffect" (3m ago)
   Summary: Documentation about the useEffect hook lifecycle...
   Topics: react, useEffect, lifecycle, cleanup, dependencies
   --- Page Content ---
   React’s useEffect hook lets you synchronize a component with an external
   system. The cleanup function runs before the component unmounts and before
   every re-render with changed dependencies. Common patterns include...
2. "SO: useEffect cleanup" (12m ago)
   Summary: Discussion about preventing memory leaks in cleanup functions...
   Topics: useEffect, memory, cleanup, subscriptions
   --- Page Content ---
   To prevent memory leaks when using subscriptions in useEffect, return a
   cleanup function that cancels the subscription...
3. "GitHub - react-query" (25m ago)
   Summary: TanStack Query repository for data fetching and caching...
   Topics: react, data-fetching, cache, tanstack, async
```

The sequence of recent page visits (up to 8), each with:
- **Summary** — Comprehensive description of the page (up to 1500 chars)
- **Page Content** — Raw content snippet (up to 2000 chars) for the most relevant pages, enabling factual answers
- **Topics** — Keywords connected to this page (up to 8 per page)
- **Temporal distance** — How long ago it was visited

The inclusion of actual page content is critical. Without it, the AI can identify *which* pages the user visited, but cannot answer specific questions about *what those pages said*. For example, knowing the user visited "CHCI - Upcoming Events" is not enough to answer "when is human trafficking awareness day?"—only the raw content contains that date.

### Layer 3: Active Cluster Detail (with Content)

```
Cluster: 12 pages, 18 keywords, 45 connections
Key pages:
  - "React Hooks API Reference" (visited 3x)
    Summary: Reference documentation for all built-in React hooks including
    useState, useEffect, useContext, useReducer, useCallback, useMemo...
    --- Page Content ---
    useState returns a stateful value and a function to update it. During
    the initial render, the returned state matches the initialState argument...
  - "Stack Overflow: Custom hooks patterns" 
    Summary: Best practices for extracting reusable hook logic into custom hooks...
```

Deep dive into the winning community — its pages with summaries, raw content (for the top pages), visit frequency, and structural statistics. The content injection budget is configurable (`MAX_DEEP_CONTENT_PAGES`, default 4) so the most relevant pages carry full detail while less relevant ones carry only summaries.

### Layer 4: Topic Relationships

```
react ↔ hooks (strength: 5.2)
useEffect ↔ lifecycle (strength: 3.1)
state ↔ useState (strength: 2.8)
```

The strongest keyword co-occurrence edges within the active community. These reveal which concepts the user encounters together most frequently — essentially, a map of their mental model's structure.

### Layer 5: Cross-Topic Connections

```
"typescript" connects React Development → Backend API
"api" connects React Development → Data Engineering
```

Keywords that bridge different communities. These help the AI understand the user's broader context — they're not just doing React development in isolation; they're also working on a backend API, and TypeScript is the shared thread.

## Assembly Pipeline

Context assembly happens at two points in the LangGraph workflows:

### During Page Analysis (per visit)

```
extract → summarize → update_graph → detect_communities → infer_task + enrich
```

After Bayesian inference determines the active task, `_enrich_context` immediately assembles deep context from the graph. This enriched context is cached for subsequent chat queries, ensuring the side panel always has current context.

### During Chat (per query)

```
retrieve_context → assemble_deep_context → generate_response
```

Before generating a chat response, `_node_assemble_deep_context` re-enriches the cached context with fresh graph data. This ensures the LLM has the latest trajectory and community state, even if the graph has been updated since the last page visit was processed.

## System Prompt Design

The enriched context is transformed into a structured prompt section by `build_context_block()`:

```
== ACTIVE TASK ==
Task: React Development
Confidence: 87%
Core topics: react, hooks, state, useEffect, components

== RECENT BROWSING TRAJECTORY ==
1. "React Docs - useEffect" (3m ago)
   Summary: Documentation about the useEffect hook lifecycle...
   Topics: react, useEffect, lifecycle
...

== ACTIVE TASK CLUSTER ==
Cluster size: 12 pages, 18 keywords, 45 connections
Key pages in this cluster:
  - "React Hooks API Reference" (visited 3x)
    Reference documentation for all built-in React hooks
...

== TOPIC RELATIONSHIPS ==
  react ↔ hooks (strength: 5.2)
  useEffect ↔ lifecycle (strength: 3.1)
...

== CROSS-TOPIC CONNECTIONS ==
  "typescript" connects React Development → Backend API
...

== ALL DETECTED TASKS ==
  - React Development (87%): react, hooks, state, useEffect
  - Backend API (10%): python, fastapi, endpoints
  - Documentation (3%): markdown, readme
```

Each section is conditionally included — empty sections are omitted to avoid wasting context window space.

## Design Principles

### Retrieval-Enrichment Balance
Retrieval (Louvain + Bayes) finds the right nodes. Enrichment (summaries, trajectories) makes those nodes informative. Both are necessary; neither is sufficient alone.

### Heuristic Summarization
Page summaries are generated locally from title + content without API calls. This keeps the ingestion pipeline fast and free while still providing semantic depth. The summarizer packs as many meaningful sentences as possible (up to 1500 chars), preserving specific facts, dates, names, and events that would otherwise be lost in a short summary.

In addition to summaries, raw content snippets (up to 3000 chars) are stored on each page node. During context assembly, the top pages (controlled by `MAX_DEEP_CONTENT_PAGES`) have their content injected directly into the LLM context block under `--- Page Content ---` sections, enabling factual question-answering.

### Temporal Coherence
Browsing trajectory is sorted by recency, giving the AI a sense of the user's *progression* through topics. This enables it to distinguish between "researching broadly" and "drilling into a specific problem."

### Graceful Degradation
When context is sparse (few pages, low confidence), the system returns an "Exploring" context with minimal enrichment rather than inventing false confidence. The AI's system prompt is designed to acknowledge forming understanding.

### Context Window Efficiency
Not all graph data is relevant. The enrichment pipeline selectively includes:
- Top N pages by recency (not all pages)
- Raw content for top M pages only (`MAX_DEEP_CONTENT_PAGES`, default 4)
- Top keyword relationships by weight (not all edges)
- Only cross-community bridges (not all inter-community edges)

This produces a context block of ~2000-8000 tokens — comprehensive enough for factual answers but controlled to avoid overwhelming the LLM's context window. The content budget is tiered: recent/relevant pages get full content injection, while older pages contribute only summaries and keywords.
