"""
NodeSense Bayesian Task Inference Engine
Implements P(Task | Browsing) ∝ P(Browsing | Task) × P(Task)
with Laplace smoothing and temporal-decay-aware priors.

Mathematical foundations documented in /MATH.md
"""

from __future__ import annotations

import math
from typing import Any

import networkx as nx

from config import settings


class BayesianTaskInferrer:
    """
    Given a set of Louvain communities and the current page's keywords,
    compute a posterior distribution over latent "tasks" (communities).

    Key formulas:

        Prior:      P(Task_i) ∝ Σ_edges_in_community(decayed_weight) + α
        Likelihood: P(Evidence | Task_i) ∝ Σ_kw∈current (overlap_weight_with_community_i) + α
        Posterior:  P(Task_i | Evidence) = P(Evidence | Task_i) × P(Task_i) / Z

    where α is the Laplace smoothing constant and Z is the normalization factor.
    """

    def __init__(self, smoothing: float | None = None):
        self.alpha = smoothing if smoothing is not None else settings.LAPLACE_SMOOTHING

    def compute_posteriors(
        self,
        current_keywords: list[str],
        communities: list[set],
        graph: nx.Graph,
    ) -> dict[int, float]:
        """
        Compute posterior probability for each community being the "active task".

        Returns dict mapping community_index → posterior_probability.
        All values sum to 1.0.
        """
        if not communities:
            return {}

        kw_ids = {f"kw:{kw.lower().strip()}" for kw in current_keywords if kw.strip()}
        n_communities = len(communities)

        # ── Priors: P(Task_i) ─────────────────────────────────────────────
        priors: list[float] = []
        for community in communities:
            # Sum of decayed edge weights within the community
            subgraph = graph.subgraph(community)
            community_weight = sum(
                data.get("weight", 1.0) for _, _, data in subgraph.edges(data=True)
            )
            priors.append(community_weight + self.alpha)

        prior_total = sum(priors)
        priors = [p / prior_total for p in priors]

        # ── Likelihoods: P(Evidence | Task_i) ────────────────────────────
        likelihoods: list[float] = []
        for community in communities:
            overlap_score = 0.0
            for kw_id in kw_ids:
                if kw_id in community:
                    # Direct membership: strong signal
                    overlap_score += 3.0
                else:
                    # Check if any keyword neighbor is in the community
                    if kw_id in graph:
                        for neighbor in graph.neighbors(kw_id):
                            if neighbor in community:
                                edge_w = graph.edges[kw_id, neighbor].get("weight", 1.0)
                                overlap_score += edge_w
            likelihoods.append(overlap_score + self.alpha)

        likelihood_total = sum(likelihoods)
        likelihoods = [l / likelihood_total for l in likelihoods]

        # ── Posteriors: Bayes' rule ──────────────────────────────────────
        unnormalized = [
            likelihoods[i] * priors[i] for i in range(n_communities)
        ]
        z = sum(unnormalized)
        if z == 0:
            # Uniform fallback
            return {i: 1.0 / n_communities for i in range(n_communities)}

        posteriors = {i: unnormalized[i] / z for i in range(n_communities)}
        return posteriors

    def get_active_context(
        self,
        posteriors: dict[int, float],
        communities: list[set],
        community_labels: list[dict],
        graph: nx.Graph,
        top_n: int = 1,
    ) -> dict[str, Any]:
        """
        From the posterior distribution, extract the most probable active context.

        Returns:
            {
                "task_label": str,
                "keywords": [str, ...],
                "confidence": float,
                "all_tasks": [{"label": ..., "probability": ...}, ...]
            }
        """
        if not posteriors:
            return self._cold_start_context()

        # Sort communities by posterior probability
        ranked = sorted(posteriors.items(), key=lambda x: x[1], reverse=True)
        top_idx, top_prob = ranked[0]

        # Cold-start guard: if confidence is too low, say "exploring"
        if top_prob < 0.25 or len(communities) < 2:
            return self._cold_start_context()

        # Extract context from the winning community
        if top_idx < len(community_labels):
            label_info = community_labels[top_idx]
            task_label = label_info.get("label", "Unknown")
            keywords = label_info.get("keywords", [])
        else:
            task_label = "Unknown"
            keywords = []

        # Build the full task table for the UI
        all_tasks = []
        for idx, prob in ranked[:5]:
            if idx < len(community_labels):
                all_tasks.append(
                    {
                        "community_idx": idx,
                        "label": community_labels[idx].get("label", f"Task {idx}"),
                        "keywords": community_labels[idx].get("keywords", []),
                        "size": community_labels[idx].get("size", 0),
                        "probability": round(prob, 4),
                    }
                )

        return {
            "task_label": task_label,
            "keywords": keywords,
            "confidence": round(top_prob, 4),
            "all_tasks": all_tasks,
        }

    @staticmethod
    def _cold_start_context() -> dict[str, Any]:
        """Returned when there isn't enough data for a reliable prediction."""
        return {
            "task_label": "Exploring",
            "keywords": [],
            "confidence": 0.0,
            "all_tasks": [],
        }

    # ── Information-theoretic metrics (bonus) ─────────────────────────────

    @staticmethod
    def entropy(posteriors: dict[int, float]) -> float:
        """
        Shannon entropy of the posterior distribution.
        High entropy → uncertain about the active task.
        Low entropy  → confident in one task.
        H = −Σ p_i log₂(p_i)
        """
        h = 0.0
        for p in posteriors.values():
            if p > 0:
                h -= p * math.log2(p)
        return h

    @staticmethod
    def kl_divergence(
        current: dict[int, float], previous: dict[int, float]
    ) -> float:
        """
        KL divergence D_KL(current || previous).
        Measures how much the context has shifted.
        Large KL → significant context switch detected.
        """
        kl = 0.0
        for i, p in current.items():
            q = previous.get(i, 1e-10)
            if p > 0:
                kl += p * math.log2(p / q)
        return kl
