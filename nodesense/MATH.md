# NodeSense — Mathematical Foundations

> This document describes the mathematical theory underpinning NodeSense's contextual inference engine. Each section provides the formal definition, the intuition, and how it maps to the implementation.

---

## Table of Contents

1. [Graph Theory Foundations](#1-graph-theory-foundations)
2. [Community Detection (Louvain Algorithm)](#2-community-detection-louvain-algorithm)
3. [Bayesian Task Inference](#3-bayesian-task-inference)
4. [Temporal Decay & Forgetting Curves](#4-temporal-decay--forgetting-curves)
5. [Markov Chains & Tab Switching](#5-markov-chains--tab-switching)
6. [Information Theory Metrics](#6-information-theory-metrics)
7. [Spectral Graph Analysis](#7-spectral-graph-analysis-bonus)
8. [How It All Connects in NodeSense](#8-how-it-all-connects-in-nodesense)

---

## 1. Graph Theory Foundations

### 1.1 Definitions

A **graph** $G = (V, E)$ consists of:
- $V$: a set of **vertices** (nodes)
- $E \subseteq V \times V$: a set of **edges** connecting pairs of vertices

A **weighted graph** assigns a function $w: E \to \mathbb{R}^+$ so each edge $(u, v)$ carries a weight $w(u,v)$.

### 1.2 NodeSense's Knowledge Graph

In NodeSense, we construct a **heterogeneous weighted undirected graph** with two node types:

| Node Type | ID Format | Attributes |
|-----------|-----------|------------|
| **Page** | `page:<url>` | `title`, `visit_count`, `first_visited`, `last_visited` |
| **Keyword** | `kw:<term>` | `label`, `frequency`, `first_seen`, `last_seen` |

**Edges** are created between:
- A page node and each of its extracted keyword nodes (page–keyword association)
- All pairs of keywords from the same page (keyword co-occurrence)

Edge weight represents **association strength** — it is incremented each time the two nodes co-appear.

### 1.3 Key Graph Metrics

**Degree Centrality** — measures how "connected" a node is:

$$C_D(v) = \frac{\deg(v)}{|V| - 1}$$

In NodeSense, high-degree keyword nodes represent dominant topics in the user's browsing.

**Weighted Degree** — sum of edge weights incident to a node:

$$d_w(v) = \sum_{(v,u) \in E} w(v, u)$$

This gives a richer measure than simple degree since frequently co-occurring topics have higher edge weights.

**Adjacency Matrix** — for a graph with $n$ nodes, the $n \times n$ matrix:

$$A_{ij} = \begin{cases} w(v_i, v_j) & \text{if } (v_i, v_j) \in E \\ 0 & \text{otherwise} \end{cases}$$

---

## 2. Community Detection (Louvain Algorithm)

### 2.1 What Are Communities?

A **community** (or cluster) is a subset of nodes that are more densely connected to each other than to the rest of the graph. In NodeSense, each community represents a **latent task** or **topic area** the user is working on.

> If a user browses React docs, Stack Overflow for React hooks, and GitHub React repos, these pages and their keywords will form a tightly-connected community = the "React Development" task.

### 2.2 Modularity

The quality of a community partition is measured by **modularity** $Q$:

$$Q = \frac{1}{2m} \sum_{ij} \left[ A_{ij} - \frac{k_i k_j}{2m} \right] \delta(c_i, c_j)$$

Where:
- $m = \frac{1}{2} \sum_{ij} A_{ij}$ — total edge weight
- $k_i = \sum_j A_{ij}$ — weighted degree of node $i$
- $c_i$ — community assignment of node $i$
- $\delta(c_i, c_j)$ — Kronecker delta: 1 if $i$ and $j$ are in the same community, 0 otherwise

**Intuition**: Modularity compares the actual density of edges within communities to the *expected* density if edges were randomly distributed. $Q > 0$ means communities have more internal edges than expected by chance.

### 2.3 The Louvain Algorithm

Louvain is a greedy, two-phase iterative algorithm:

**Phase 1 — Local Node Moves**:
1. Start with each node in its own community
2. For each node $i$, evaluate the modularity gain $\Delta Q$ of moving $i$ to each neighboring community
3. Move $i$ to the community giving the maximum positive $\Delta Q$
4. Repeat until no move improves modularity

The modularity gain from moving node $i$ into community $C$ is:

$$\Delta Q = \left[ \frac{\sum_{in} + 2 k_{i,in}}{2m} - \left( \frac{\sum_{tot} + k_i}{2m} \right)^2 \right] - \left[ \frac{\sum_{in}}{2m} - \left( \frac{\sum_{tot}}{2m} \right)^2 - \left( \frac{k_i}{2m} \right)^2 \right]$$

Where:
- $\sum_{in}$ — sum of edge weights inside community $C$
- $\sum_{tot}$ — sum of all edge weights incident to nodes in $C$
- $k_{i,in}$ — sum of weights of edges from $i$ to nodes in $C$
- $k_i$ — weighted degree of $i$

**Phase 2 — Graph Contraction**:
1. Build a new graph where each community from Phase 1 becomes a single node
2. Edge weights between new nodes = sum of inter-community edge weights
3. Self-loops = sum of intra-community edge weights

Repeat Phase 1 and 2 until convergence.

### 2.4 Resolution Parameter

The `resolution` parameter $\gamma$ modifies the modularity formula:

$$Q_\gamma = \frac{1}{2m} \sum_{ij} \left[ A_{ij} - \gamma \frac{k_i k_j}{2m} \right] \delta(c_i, c_j)$$

- $\gamma > 1$ → favors **smaller** communities (more granular task detection)
- $\gamma < 1$ → favors **larger** communities (broader task groupings)
- $\gamma = 1$ → standard modularity (NodeSense default)

### 2.5 Implementation Note

NodeSense uses `networkx.community.louvain_communities(G, weight='weight', resolution=1.0, seed=42)`. The fixed `seed=42` ensures **deterministic** results — without it, Louvain's random node ordering can produce different community assignments on each run, causing task labels to "flicker."

---

## 3. Bayesian Task Inference

### 3.1 Bayes' Theorem

Given observed browsing evidence $E$ (the keywords from the current page), we want to infer the most probable task $T_i$ (community):

$$P(T_i \mid E) = \frac{P(E \mid T_i) \cdot P(T_i)}{P(E)}$$

Since $P(E)$ is constant across all tasks, we use the **proportional form**:

$$P(T_i \mid E) \propto P(E \mid T_i) \cdot P(T_i)$$

### 3.2 Prior: P(T_i)

The **prior probability** of each task represents how "active" that task has been recently:

$$P(T_i) = \frac{\sum_{e \in E_{C_i}} w_{\text{decayed}}(e) + \alpha}{\sum_{j} \left( \sum_{e \in E_{C_j}} w_{\text{decayed}}(e) + \alpha \right)}$$

Where:
- $E_{C_i}$ — edges within community $C_i$
- $w_{\text{decayed}}(e)$ — temporally decayed edge weight (see §4)
- $\alpha$ — **Laplace smoothing** constant (default 0.1)

**Laplace smoothing** prevents any task from having zero prior, which would permanently exclude it from consideration regardless of evidence. It implements the principle that every task has at least some small baseline probability.

### 3.3 Likelihood: P(E | T_i)

The **likelihood** measures how well the current evidence (page keywords) matches each community:

$$P(E \mid T_i) = \frac{\text{overlap\_score}(E, C_i) + \alpha}{\sum_j (\text{overlap\_score}(E, C_j) + \alpha)}$$

The overlap score has two components:
1. **Direct membership** (weight = 3.0): keyword $k \in C_i$ directly
2. **Neighbor membership** (weight = edge weight): keyword $k$ has a neighbor in $C_i$

$$\text{overlap\_score}(E, C_i) = \sum_{k \in E} \begin{cases} 3.0 & \text{if } k \in C_i \\ \sum_{n \in \mathcal{N}(k) \cap C_i} w(k, n) & \text{otherwise} \end{cases}$$

### 3.4 Posterior Normalization

The raw posteriors are normalized to form a valid probability distribution:

$$P(T_i \mid E) = \frac{P(E \mid T_i) \cdot P(T_i)}{\sum_j P(E \mid T_j) \cdot P(T_j)}$$

The task with the highest posterior is declared the **active context**.

### 3.5 Cold Start Handling

When there are fewer than 2 communities, or the top posterior is below 0.25, the system returns an "Exploring" context with zero confidence rather than providing unreliable predictions.

---

## 4. Temporal Decay & Forgetting Curves

### 4.1 Exponential Decay

Edge weights decay over time to model the fading relevance of older browsing activity:

$$w(t) = w_0 \cdot e^{-\lambda \Delta t}$$

Where:
- $w_0$ — base weight (accumulated co-occurrence count)
- $\lambda$ — decay rate (default: 0.01 per hour)
- $\Delta t = t_{\text{now}} - t_{\text{last\_active}}$ — hours since the edge was last reinforced

### 4.2 Half-Life

The **half-life** $t_{1/2}$ is the time required for a weight to drop to 50% of its base value:

$$t_{1/2} = \frac{\ln 2}{\lambda}$$

With $\lambda = 0.01$/hour:

$$t_{1/2} = \frac{0.693}{0.01} \approx 69.3 \text{ hours} \approx 2.9 \text{ days}$$

This means browsing activity from 3 days ago has about half the influence of today's activity.

### 4.3 Connection to Ebbinghaus Forgetting Curves

Hermann Ebbinghaus (1885) discovered that human memory retention follows an exponential decay:

$$R(t) = e^{-t/S}$$

Where $S$ is the "stability" of the memory. NodeSense's temporal decay mirrors this: just as humans gradually forget unreinforced information, the knowledge graph gradually weakens old associations. Repeated visits to the same topic (increasing $w_0$) act like **spaced repetition**, keeping those associations strong.

### 4.4 Edge Pruning

Edges with decayed weight below $\epsilon = 0.01$ are removed entirely, and any resulting orphan nodes (degree 0) are also removed. This prevents unbounded graph growth while preserving meaningful structure.

---

## 5. Markov Chains & Tab Switching

### 5.1 Browsing as a Markov Process

Tab switching can be modeled as a **discrete-time Markov chain** where:
- **States** = topics / web pages
- **Transition probability** $P(X_{t+1} = j \mid X_t = i)$ = probability of visiting topic $j$ next, given current topic $i$

The **transition matrix** $\mathbf{P}$ is:

$$P_{ij} = \frac{w(i, j)}{\sum_k w(i, k)}$$

Each row sums to 1 (stochastic matrix).

### 5.2 Stationary Distribution

The **stationary distribution** $\boldsymbol{\pi}$ satisfies:

$$\boldsymbol{\pi} = \boldsymbol{\pi} \mathbf{P}$$

This represents the long-run proportion of time spent on each topic. Topics with high $\pi_i$ are the user's most persistent interests.

### 5.3 Connection to PageRank

Google's PageRank is essentially the stationary distribution of a modified Markov chain with a damping factor:

$$\pi_i = \frac{1 - d}{N} + d \sum_{j \to i} \frac{\pi_j}{L(j)}$$

While NodeSense doesn't implement full PageRank, the analogy is illuminating: **important keywords are those that many pages "link" to** (high weighted degree), just as important web pages are those that many other pages link to.

---

## 6. Information Theory Metrics

### 6.1 Shannon Entropy

The **entropy** of the task posterior distribution measures uncertainty:

$$H = -\sum_{i=1}^{n} P(T_i \mid E) \log_2 P(T_i \mid E)$$

| Value | Interpretation |
|-------|----------------|
| $H = 0$ | Completely certain — one task has probability 1.0 |
| $H = \log_2(n)$ | Maximally uncertain — uniform distribution across $n$ tasks |
| Low $H$ | Confident: the user is clearly in one task context |
| High $H$ | Ambiguous: browsing activity spans multiple task areas |

NodeSense uses entropy to gauge confidence quality. A confident task prediction with low entropy is more trustworthy than one with the same top posterior but high entropy.

### 6.2 KL Divergence (Context Shift Detection)

The **Kullback-Leibler divergence** measures how different the current posterior is from the previous one:

$$D_{KL}(P_{\text{current}} \| P_{\text{previous}}) = \sum_i P_{\text{current}}(T_i) \log_2 \frac{P_{\text{current}}(T_i)}{P_{\text{previous}}(T_i)}$$

Properties:
- $D_{KL} = 0$ → no context shift (same task focus)
- Large $D_{KL}$ → significant context switch detected
- **Asymmetric**: $D_{KL}(P \| Q) \neq D_{KL}(Q \| P)$

NodeSense can use this to detect **task switching** — if KL divergence exceeds a threshold (e.g., 1.0 bit), the user likely shifted from one task to another.

### 6.3 Mutual Information

The **mutual information** between two keywords measures their statistical dependence:

$$I(X; Y) = \sum_{x \in X} \sum_{y \in Y} P(x, y) \log_2 \frac{P(x, y)}{P(x) P(y)}$$

High mutual information between two keywords means they consistently appear together — they are part of the same "conceptual unit." This justifies using co-occurrence edges as the basis for community detection.

---

## 7. Spectral Graph Analysis (Bonus)

### 7.1 The Graph Laplacian

For a graph with adjacency matrix $\mathbf{A}$ and degree matrix $\mathbf{D}$ (diagonal matrix of node degrees), the **Laplacian** is:

$$\mathbf{L} = \mathbf{D} - \mathbf{A}$$

The **normalized Laplacian**:

$$\mathcal{L} = \mathbf{D}^{-1/2} \mathbf{L} \mathbf{D}^{-1/2} = \mathbf{I} - \mathbf{D}^{-1/2} \mathbf{A} \mathbf{D}^{-1/2}$$

### 7.2 Eigenvalues and Community Structure

The eigenvalues $0 = \lambda_1 \leq \lambda_2 \leq \dots \leq \lambda_n$ of $\mathbf{L}$ reveal graph structure:

- **Number of zero eigenvalues** = number of connected components
- **Algebraic connectivity** $\lambda_2$ (Fiedler value): how "well-connected" the graph is
  - $\lambda_2 = 0$ → graph is disconnected
  - Small $\lambda_2$ → graph has a natural "cut" into two communities
  - Large $\lambda_2$ → graph is densely connected
- The **eigengap** (jump between consecutive eigenvalues) indicates the optimal number of communities: if $\lambda_k \ll \lambda_{k+1}$, then $k$ communities is a good partition

### 7.3 Spectral Clustering

The eigenvectors of $\mathbf{L}$ corresponding to the smallest eigenvalues provide a natural embedding for community detection:

1. Compute the first $k$ eigenvectors $\mathbf{v}_1, \dots, \mathbf{v}_k$
2. Form matrix $\mathbf{U} \in \mathbb{R}^{n \times k}$ using these eigenvectors as columns
3. Cluster the rows of $\mathbf{U}$ using k-means

While NodeSense uses Louvain (faster, more practical), spectral methods provide theoretical justification for *why* community detection works: communities correspond to regions of the graph that are separated by low-weight cuts, which manifests as gaps in the eigenvalue spectrum.

---

## 8. How It All Connects in NodeSense

The complete inference pipeline in one mathematical flow:

```
Page Visit (url, title, content)
        │
        ▼
[Entity Extraction] ──── LLM extracts keywords k₁, k₂, ..., kₙ
        │
        ▼
[Graph Update] ──── For each kᵢ, kⱼ:
        │             w(kᵢ, kⱼ) ← w(kᵢ, kⱼ) + 1    (co-occurrence)
        │             For all edges: w(t) = w₀·e^{-λΔt}  (decay)
        │
        ▼
[Community Detection] ── Louvain: maximize Q = 1/(2m) Σ[Aᵢⱼ − γkᵢkⱼ/(2m)]δ(cᵢ,cⱼ)
        │                 → Communities C₁, C₂, ..., Cₘ
        │
        ▼
[Bayesian Inference] ── For each community Cᵢ:
        │                  P(Cᵢ) ∝ Σ w_decayed(edges in Cᵢ) + α
        │                  P(E|Cᵢ) ∝ overlap(keywords, Cᵢ) + α
        │                  P(Cᵢ|E) = P(E|Cᵢ)·P(Cᵢ) / Z
        │
        ▼
[Active Context] ──── C* = argmax P(Cᵢ|E)
        │              confidence = P(C*|E)
        │              entropy H = −Σ P(Cᵢ|E) log₂ P(Cᵢ|E)
        │
        ▼
[GraphRAG Query] ──── System prompt enriched with C*'s keywords
                       → contextually-aware LLM response
```

This pipeline runs on **every page visit**, continuously refining the knowledge graph and updating the Bayesian posterior. The result is a system that learns the user's browsing context in real-time without explicit user input — a mathematically grounded approach to contextual awareness.

---

## References

1. Blondel, V.D., Guillaume, J.L., Lambiotte, R., Lefebvre, E. (2008). "Fast unfolding of communities in large networks." *Journal of Statistical Mechanics*, P10008.
2. Ebbinghaus, H. (1885). *Über das Gedächtnis* (On Memory).
3. Shannon, C.E. (1948). "A Mathematical Theory of Communication." *Bell System Technical Journal*, 27(3), 379–423.
4. Page, L., Brin, S., Motwani, R., Winograd, T. (1999). "The PageRank Citation Ranking: Bringing Order to the Web." Stanford InfoLab.
5. Newman, M.E.J. (2006). "Modularity and community structure in networks." *PNAS*, 103(23), 8577–8582.
6. Von Luxburg, U. (2007). "A Tutorial on Spectral Clustering." *Statistics and Computing*, 17(4), 395–416.
