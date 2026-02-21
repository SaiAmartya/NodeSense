# Knowledge Graph

How NodeSense builds, maintains, and queries its browsing knowledge graph.

---

## What It Is

The knowledge graph is an **in-memory weighted undirected graph** (NetworkX) that models the relationships between web pages and topics in a user's browsing activity. It serves as the structural backbone for all contextual understanding.

Unlike a simple list of visited URLs, the knowledge graph captures **associations** — which topics co-occur, which pages relate to which concepts, and how these relationships evolve over time through temporal decay.

## Node Types

The graph contains two types of nodes, distinguished by ID prefix:

### Page Nodes (`page:<url>`)

Represent individual web pages the user has visited.

| Attribute | Purpose |
|-----------|---------|
| `title` | Human-readable page title |
| `url` | Full URL for reference |
| `summary` | Concise description of the page content (heuristically generated) |
| `content_snippet` | First ~500 chars of page body text for reference |
| `visit_count` | Number of times the user has visited this page |
| `first_visited` | Unix timestamp of the first visit |
| `last_visited` | Unix timestamp of the most recent visit |

**Page summaries** are generated heuristically from the page title and content — no API calls needed. They capture the *essence* of what each page is about, enabling the AI to reason about specific pages rather than just abstract keywords.

### Keyword Nodes (`kw:<term>`)

Represent topics or concepts extracted from page content.

| Attribute | Purpose |
|-----------|---------|
| `label` | The keyword/phrase itself (lowercase) |
| `frequency` | How many pages this keyword has been extracted from |
| `page_refs` | List of URLs where this keyword appears (latest 10) |
| `first_seen` | When this keyword was first encountered |
| `last_seen` | When this keyword was most recently seen |

**Page references** (`page_refs`) give keywords provenance — you can trace a keyword back to the pages that generated it, creating a bidirectional lookup between topics and their sources.

## Edge Types

Edges represent **association strength** between nodes:

### Page ↔ Keyword Edges
Created when a keyword is extracted from a page. Weight increases with each visit to that page.

### Keyword ↔ Keyword Edges  
Created when two keywords are extracted from the same page (co-occurrence). These capture semantic relationships between concepts — if "react" and "hooks" consistently appear on the same pages, their edge weight grows, signaling a strong topical association.

### Edge Attributes

| Attribute | Purpose |
|-----------|---------|
| `base_weight` | Raw co-occurrence count (incremented on each joint appearance) |
| `weight` | Temporally decayed weight used for all computations |
| `last_active` | When this edge was last reinforced |
| `created` | When this edge was first created |

## Temporal Decay

Edge weights decay exponentially over time:

```
w(t) = base_weight × e^(-λ × hours_since_last_active)
```

With the default decay rate (λ = 0.01/hour), the half-life is ~69 hours (~3 days). This means:

- **Today's activity** has near-full weight
- **Yesterday's activity** retains ~79% of its weight
- **Last week's activity** retains ~19% of its weight
- **Edges below 0.01 weight** are pruned entirely (along with resulting orphan nodes)

This models the natural fading of relevance — old browsing activity gradually loses influence unless reinforced by revisits.

## Community Detection

The Louvain algorithm partitions the graph into **communities** — dense clusters of interconnected nodes that represent latent task areas.

**Example:** If a user browses React docs, Stack Overflow for React hooks, and a GitHub repo about React components, the pages and their extracted keywords form a tightly connected subgraph. Louvain identifies this cluster as a community, which the Bayesian engine then labels as a "task."

Key behaviors:
- **Resolution parameter** (default 1.0): Controls community granularity. Higher = smaller, more specific communities. Lower = broader groupings.
- **Deterministic seed** (42): Ensures consistent community assignments across runs, preventing task labels from "flickering."
- **Community labels**: The top keyword by weighted degree within each community becomes its label.

## Querying the Graph

### Subgraph Extraction
Given a set of keywords, retrieve the n-hop neighborhood — all nodes within `n` edge traversals of those keywords. Used for targeted context retrieval.

### Rich Community Context
For a given community, assemble:
- **Page summaries** — Recent pages in the cluster with their summaries, sorted by recency
- **Keyword relationships** — The strongest keyword↔keyword edges within the community, revealing which concepts are most tightly coupled
- **Statistics** — Total pages, keywords, and connections in the cluster

### Browsing Trajectory
The most recently visited pages across the entire graph, each with:
- Title and URL
- Page summary
- Connected keywords
- Time since last visit

This temporal ordering gives the AI a sense of the user's browsing *sequence*, not just a bag of topics.

### Cross-Community Bridges
Keywords that have edges bridging into multiple communities. These represent **conceptual connections** between different task areas — for example, "typescript" might bridge a "React Development" cluster and a "Backend API" cluster.

## Pruning & Growth Management

The graph enforces a maximum node count (default 500). When exceeded:

1. Each node is scored: `weighted_degree × recency_factor`
2. Lowest-scoring nodes are removed until the graph is within bounds
3. This preserves high-value, recently-active nodes while shedding stale, low-connectivity nodes

## Persistence

The graph is serialized to `graph.pkl` via Python's pickle module:
- **Load**: On backend startup
- **Save**: On backend shutdown
- **Reset**: Delete `graph.pkl` to start fresh

## Design Decisions

**Why NetworkX (not Neo4j/etc.)?**  
NodeSense's graph is per-user and remains small enough to fit in memory (max 500 nodes). NetworkX provides zero-dependency graph operations with excellent algorithm support (Louvain, BFS, subgraph extraction). No database server needed.

**Why heterogeneous nodes (page + keyword)?**  
Separating pages from keywords enables two distinct retrieval strategies: keyword-based (conceptual) and page-based (source-specific). The bipartite structure also means community detection groups related pages *and* related concepts together.

**Why store summaries on nodes?**  
Raw keyword lists are insufficient for the AI to understand context deeply. Page summaries bridge the gap between "the user visited pages about React hooks" and "the user was reading documentation about useEffect cleanup patterns and how to avoid memory leaks." This semantic depth is what enables genuinely helpful AI responses.
