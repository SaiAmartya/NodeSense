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

### Layer 2: Browsing Trajectory

```
1. "React Docs - useEffect" (3m ago)
   Summary: Documentation about the useEffect hook lifecycle...
   Topics: react, useEffect, lifecycle
2. "SO: useEffect cleanup" (12m ago)
   Summary: Discussion about preventing memory leaks in cleanup functions...
   Topics: useEffect, memory, cleanup
3. "GitHub - react-query" (25m ago)
   Summary: TanStack Query repository for data fetching and caching...
   Topics: react, data-fetching, cache
```

The sequence of recent page visits, each with:
- **Summary** — What the page was about (stored on node)
- **Topics** — Keywords connected to this page (graph edges)
- **Temporal distance** — How long ago it was visited

This gives the AI temporal reasoning: it can see the user went from reading React Query docs → debugging useEffect cleanup → reading the official useEffect docs. That's a debugging trajectory, not just a topic list.

### Layer 3: Active Cluster Detail

```
Cluster: 12 pages, 18 keywords, 45 connections
Key pages:
  - "React Hooks API Reference" (visited 3x)
    Reference documentation for all built-in React hooks
  - "Stack Overflow: Custom hooks patterns" 
    Best practices for extracting reusable hook logic
```

Deep dive into the winning community — its pages with summaries, visit frequency, and structural statistics. This tells the AI about the *breadth* and *depth* of the user's engagement with this topic.

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
Page summaries are generated locally from title + content without API calls. This keeps the ingestion pipeline fast and free while still providing semantic depth. The summarizer extracts the first 1-2 meaningful sentences, producing concise but informative descriptions.

### Temporal Coherence
Browsing trajectory is sorted by recency, giving the AI a sense of the user's *progression* through topics. This enables it to distinguish between "researching broadly" and "drilling into a specific problem."

### Graceful Degradation
When context is sparse (few pages, low confidence), the system returns an "Exploring" context with minimal enrichment rather than inventing false confidence. The AI's system prompt is designed to acknowledge forming understanding.

### Context Window Efficiency
Not all graph data is relevant. The enrichment pipeline selectively includes:
- Top N pages by recency (not all pages)
- Top keyword relationships by weight (not all edges)
- Only cross-community bridges (not all inter-community edges)

This produces a context block of ~500-1500 tokens — informative but not overwhelming.
