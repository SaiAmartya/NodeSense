# NodeSense Documentation

Conceptual documentation for NodeSense's core systems. For mathematical foundations, see [MATH.md](../MATH.md).

## Contents

| Document | Description |
|----------|-------------|
| [Knowledge Graph](knowledge-graph.md) | How the browsing knowledge graph is structured, populated, and queried |
| [Context Engine](context-engine.md) | How raw browsing data becomes rich, structured context for the AI |
| [AI Strategy](ai-strategy.md) | Two-tier AI architecture: Gemini Nano (on-device) + Gemini Flash (server) |
| [Data Flow](data-flow.md) | End-to-end data flow from page visit to contextual AI response |

## Quick Orientation

NodeSense is a **contextually-aware browser AI** that works by:

1. **Observing** — Content scripts passively scrape page metadata as you browse
2. **Structuring** — A NetworkX knowledge graph organizes pages, keywords, and their relationships
3. **Understanding** — Louvain community detection + Bayesian inference identify what task you're working on
4. **Assisting** — Deep GraphRAG context injection gives the LLM genuine understanding of your activity

The key insight: **retrieval determines what nodes are relevant; enrichment determines how useful those nodes are.** NodeSense balances both — using probabilistic retrieval (community detection + Bayesian inference) to find the right context, and semantic enrichment (page summaries, browsing trajectories, keyword relationships) to make that context deeply informative.
