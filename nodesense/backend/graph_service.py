"""
NodeSense Graph Service
Manages the NetworkX knowledge graph — CRUD operations, temporal decay,
community detection, persistence, and pruning.
"""

from __future__ import annotations

import math
import pickle
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import networkx as nx
from networkx.algorithms.community import louvain_communities

from config import settings


class GraphService:
    """Wraps a weighted NetworkX graph that models browsing-topic relationships."""

    def __init__(self, persist_path: str | None = None):
        self.persist_path = persist_path or settings.GRAPH_PERSIST_PATH
        self.graph: nx.Graph = nx.Graph()
        self._communities: list[set] = []
        self._community_labels: list[dict] = []

    # ── Persistence ───────────────────────────────────────────────────────

    def load(self) -> None:
        """Load graph from disk (pickle). No-op if file doesn't exist."""
        p = Path(self.persist_path)
        if p.exists():
            with open(p, "rb") as f:
                self.graph = pickle.load(f)

    def save(self) -> None:
        """Persist graph to disk."""
        with open(self.persist_path, "wb") as f:
            pickle.dump(self.graph, f)

    # ── Core Graph Mutations ──────────────────────────────────────────────

    def add_page_visit(
        self,
        url: str,
        title: str,
        keywords: list[str],
        timestamp: float | None = None,
    ) -> None:
        """
        Record a page visit by:
        1. Upserting a URL node
        2. Upserting keyword nodes
        3. Creating/strengthening URL↔keyword edges
        4. Creating/strengthening keyword↔keyword co-occurrence edges
        5. Pruning if graph exceeds MAX_GRAPH_NODES
        """
        ts = timestamp or time.time()

        # --- URL node ---
        url_id = f"page:{url}"
        if self.graph.has_node(url_id):
            self.graph.nodes[url_id]["visit_count"] += 1
            self.graph.nodes[url_id]["last_visited"] = ts
        else:
            self.graph.add_node(
                url_id,
                type="page",
                title=title,
                url=url,
                visit_count=1,
                first_visited=ts,
                last_visited=ts,
            )

        # --- Keyword nodes + edges ---
        kw_ids: list[str] = []
        for kw in keywords:
            kw_lower = kw.lower().strip()
            if not kw_lower:
                continue
            kw_id = f"kw:{kw_lower}"
            kw_ids.append(kw_id)

            # Upsert keyword node
            if self.graph.has_node(kw_id):
                self.graph.nodes[kw_id]["frequency"] += 1
                self.graph.nodes[kw_id]["last_seen"] = ts
            else:
                self.graph.add_node(
                    kw_id,
                    type="keyword",
                    label=kw_lower,
                    frequency=1,
                    first_seen=ts,
                    last_seen=ts,
                )

            # URL ↔ keyword edge
            self._upsert_edge(url_id, kw_id, ts)

        # --- Keyword co-occurrence edges ---
        for i in range(len(kw_ids)):
            for j in range(i + 1, len(kw_ids)):
                self._upsert_edge(kw_ids[i], kw_ids[j], ts)

        # --- Prune ---
        self._prune_if_needed()

    def _upsert_edge(self, u: str, v: str, ts: float) -> None:
        """Create or strengthen an edge between two nodes."""
        if self.graph.has_edge(u, v):
            data = self.graph.edges[u, v]
            data["base_weight"] = data.get("base_weight", 1.0) + 1.0
            data["last_active"] = ts
            data["weight"] = data["base_weight"]  # will be decayed later
        else:
            self.graph.add_edge(
                u, v, base_weight=1.0, weight=1.0, last_active=ts, created=ts
            )

    # ── Temporal Decay ────────────────────────────────────────────────────

    def apply_temporal_decay(self, decay_rate: float | None = None) -> int:
        """
        Apply exponential decay to all edge weights:
            w(t) = base_weight × e^(−λ × Δt_hours)

        Returns the number of edges removed (weight < 0.01).
        """
        lam = decay_rate if decay_rate is not None else settings.DECAY_RATE
        now = time.time()
        to_remove: list[tuple[str, str]] = []

        for u, v, data in self.graph.edges(data=True):
            hours = (now - data.get("last_active", now)) / 3600.0
            decayed = data.get("base_weight", 1.0) * math.exp(-lam * hours)
            data["weight"] = decayed
            if decayed < 0.01:
                to_remove.append((u, v))

        for u, v in to_remove:
            self.graph.remove_edge(u, v)

        # Remove orphan nodes (no edges)
        orphans = [n for n in self.graph.nodes if self.graph.degree(n) == 0]
        self.graph.remove_nodes_from(orphans)

        return len(to_remove)

    # ── Community Detection ───────────────────────────────────────────────

    def detect_communities(
        self,
        resolution: float | None = None,
        seed: int | None = None,
    ) -> list[set]:
        """
        Run Louvain community detection on the current graph.
        Returns list of sets (each set = node IDs in that community).
        Caches result in self._communities.
        """
        if self.graph.number_of_nodes() < 2:
            self._communities = (
                [set(self.graph.nodes)] if self.graph.number_of_nodes() == 1 else []
            )
            self._community_labels = self._label_communities(self._communities)
            return self._communities

        res = resolution if resolution is not None else settings.COMMUNITY_RESOLUTION
        s = seed if seed is not None else settings.COMMUNITY_SEED

        try:
            self._communities = list(
                louvain_communities(self.graph, weight="weight", resolution=res, seed=s)
            )
        except Exception:
            # Fallback: treat entire graph as one community
            self._communities = [set(self.graph.nodes)]

        self._community_labels = self._label_communities(self._communities)
        return self._communities

    def _label_communities(self, communities: list[set]) -> list[dict]:
        """
        For each community, pick a human-readable label from the most
        central keyword node and extract top keywords.
        """
        labels: list[dict] = []
        for community in communities:
            kw_nodes = [
                n for n in community if self.graph.nodes[n].get("type") == "keyword"
            ]
            if not kw_nodes:
                # Use page title of the most connected page node
                page_nodes = [
                    n for n in community if self.graph.nodes[n].get("type") == "page"
                ]
                if page_nodes:
                    best = max(page_nodes, key=lambda n: self.graph.degree(n))
                    labels.append(
                        {
                            "label": self.graph.nodes[best].get("title", best),
                            "keywords": [],
                            "size": len(community),
                        }
                    )
                else:
                    labels.append(
                        {"label": "Unknown", "keywords": [], "size": len(community)}
                    )
                continue

            # Rank keyword nodes by weighted degree within the community subgraph
            subgraph = self.graph.subgraph(community)
            ranked = sorted(
                kw_nodes, key=lambda n: subgraph.degree(n, weight="weight"), reverse=True
            )
            top_kws = [
                self.graph.nodes[n].get("label", n.replace("kw:", ""))
                for n in ranked[:5]
            ]

            labels.append(
                {
                    "label": top_kws[0] if top_kws else "Unknown",
                    "keywords": top_kws,
                    "size": len(community),
                }
            )
        return labels

    @property
    def communities(self) -> list[set]:
        return self._communities

    @property
    def community_labels(self) -> list[dict]:
        return self._community_labels

    # ── Querying ──────────────────────────────────────────────────────────

    def get_subgraph_for_keywords(self, keywords: list[str], hops: int = 1) -> nx.Graph:
        """Return the n-hop neighborhood subgraph around the given keywords."""
        seed_nodes: set[str] = set()
        for kw in keywords:
            kw_id = f"kw:{kw.lower().strip()}"
            if kw_id in self.graph:
                seed_nodes.add(kw_id)

        # BFS expansion
        frontier = seed_nodes.copy()
        for _ in range(hops):
            next_frontier: set[str] = set()
            for n in frontier:
                next_frontier.update(self.graph.neighbors(n))
            frontier = next_frontier - seed_nodes
            seed_nodes.update(frontier)

        return self.graph.subgraph(seed_nodes).copy()

    def find_community_for_keywords(self, keywords: list[str]) -> int | None:
        """
        Find which community the given keywords best belong to.
        Returns community index or None.
        """
        if not self._communities:
            return None

        kw_ids = {f"kw:{kw.lower().strip()}" for kw in keywords}
        best_idx = None
        best_overlap = 0

        for idx, community in enumerate(self._communities):
            overlap = len(kw_ids & community)
            if overlap > best_overlap:
                best_overlap = overlap
                best_idx = idx

        return best_idx

    # ── Stats / Serialization ─────────────────────────────────────────────

    def get_stats(self) -> dict[str, Any]:
        """Return high-level graph statistics."""
        kw_nodes = [
            (n, self.graph.degree(n, weight="weight"))
            for n in self.graph.nodes
            if self.graph.nodes[n].get("type") == "keyword"
        ]
        kw_nodes.sort(key=lambda x: x[1], reverse=True)
        top_kws = [
            self.graph.nodes[n].get("label", n) for n, _ in kw_nodes[:10]
        ]

        return {
            "node_count": self.graph.number_of_nodes(),
            "edge_count": self.graph.number_of_edges(),
            "community_count": len(self._communities),
            "top_keywords": top_kws,
        }

    def to_serializable(self) -> dict:
        """Convert graph to a JSON-serializable dict for the frontend."""
        # Build community index for each node
        node_community = {}
        for idx, community in enumerate(self._communities):
            for n in community:
                node_community[n] = idx

        nodes = []
        for n, data in self.graph.nodes(data=True):
            node_data = {"id": n, "community": node_community.get(n, -1)}
            for k, v in data.items():
                node_data[k] = v
            nodes.append(node_data)

        edges = []
        for u, v, data in self.graph.edges(data=True):
            edge_data = {"source": u, "target": v}
            for k, val in data.items():
                edge_data[k] = val
            edges.append(edge_data)

        stats = self.get_stats()
        return {**stats, "nodes": nodes, "edges": edges}

    # ── Pruning ───────────────────────────────────────────────────────────

    def _prune_if_needed(self) -> None:
        """Remove lowest-value nodes if graph exceeds MAX_GRAPH_NODES."""
        max_nodes = settings.MAX_GRAPH_NODES
        if self.graph.number_of_nodes() <= max_nodes:
            return

        # Score = weighted degree × recency
        now = time.time()
        scores: list[tuple[str, float]] = []
        for n, data in self.graph.nodes(data=True):
            deg = self.graph.degree(n, weight="weight")
            last = data.get("last_visited", data.get("last_seen", now))
            hours_ago = (now - last) / 3600.0
            recency = math.exp(-0.005 * hours_ago)
            scores.append((n, deg * recency))

        scores.sort(key=lambda x: x[1])
        to_remove = [n for n, _ in scores[: self.graph.number_of_nodes() - max_nodes]]
        self.graph.remove_nodes_from(to_remove)
