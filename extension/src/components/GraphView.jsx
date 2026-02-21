/**
 * NodeSense — GraphView Component
 *
 * 2D force-directed knowledge graph visualization using HTML5 Canvas.
 * Shows nodes (colored by community), edges (opacity = weight),
 * labels on hover, and auto-refreshes every 5 seconds.
 */

import React, { useRef, useEffect, useState, useCallback } from "react";

// ── Community color palette ──────────────────────────────────────────────────
const COMMUNITY_COLORS = [
  "#06d6a0", // green
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#ef4444", // red
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#84cc16", // lime
];

function getCommunityColor(idx) {
  if (idx < 0) return "#64748b";
  return COMMUNITY_COLORS[idx % COMMUNITY_COLORS.length];
}

// ── Simple force simulation ──────────────────────────────────────────────────

function runForceLayout(nodes, edges, width, height, iterations = 80) {
  if (nodes.length === 0) return [];

  // Initialize positions randomly
  const positions = nodes.map(() => ({
    x: width * 0.2 + Math.random() * width * 0.6,
    y: height * 0.2 + Math.random() * height * 0.6,
    vx: 0,
    vy: 0,
  }));

  const nodeIndex = {};
  nodes.forEach((n, i) => { nodeIndex[n.id] = i; });

  const repulsion = 800;
  const attraction = 0.02;
  const centerForce = 0.01;
  const damping = 0.85;

  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations; // cooling

    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = positions[i].x - positions[j].x;
        const dy = positions[i].y - positions[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const force = (repulsion * temp) / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        positions[i].vx += fx;
        positions[i].vy += fy;
        positions[j].vx -= fx;
        positions[j].vy -= fy;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const si = nodeIndex[edge.source];
      const ti = nodeIndex[edge.target];
      if (si === undefined || ti === undefined) continue;
      const dx = positions[ti].x - positions[si].x;
      const dy = positions[ti].y - positions[si].y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
      const w = Math.min(edge.weight || 1, 5);
      const force = attraction * dist * w * temp;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      positions[si].vx += fx;
      positions[si].vy += fy;
      positions[ti].vx -= fx;
      positions[ti].vy -= fy;
    }

    // Center gravity
    for (let i = 0; i < nodes.length; i++) {
      positions[i].vx += (width / 2 - positions[i].x) * centerForce;
      positions[i].vy += (height / 2 - positions[i].y) * centerForce;
    }

    // Apply velocities with damping
    for (let i = 0; i < nodes.length; i++) {
      positions[i].vx *= damping;
      positions[i].vy *= damping;
      positions[i].x += positions[i].vx;
      positions[i].y += positions[i].vy;
      // Keep within bounds
      positions[i].x = Math.max(24, Math.min(width - 24, positions[i].x));
      positions[i].y = Math.max(24, Math.min(height - 24, positions[i].y));
    }
  }

  return positions;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GraphView({ requestGraph, onMessage }) {
  const canvasRef = useRef(null);
  const [graphData, setGraphData] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const layoutRef = useRef(null);

  // Request graph data on mount and every 5 seconds
  useEffect(() => {
    requestGraph();
    const interval = setInterval(requestGraph, 5000);
    return () => clearInterval(interval);
  }, [requestGraph]);

  // Listen for graph data from service worker
  useEffect(() => {
    const cleanup = onMessage("GRAPH_DATA", (msg) => {
      if (msg.graph) {
        setGraphData(msg.graph);
      }
    });
    return cleanup;
  }, [onMessage]);

  // Compute layout when graph data changes
  useEffect(() => {
    if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
      layoutRef.current = null;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    layoutRef.current = runForceLayout(graphData.nodes, graphData.edges || [], w, h);
  }, [graphData]);

  // Draw the graph
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (!graphData || !layoutRef.current || graphData.nodes.length === 0) {
      // Empty state
      ctx.fillStyle = "#64748b";
      ctx.font = "13px 'DM Sans', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Browse pages to build your graph", w / 2, h / 2 - 10);
      ctx.font = "11px 'DM Sans', sans-serif";
      ctx.fillStyle = "#475569";
      ctx.fillText("Nodes and edges appear as you browse", w / 2, h / 2 + 12);
      return;
    }

    const positions = layoutRef.current;
    const nodes = graphData.nodes;
    const edges = graphData.edges || [];
    const nodeIndex = {};
    nodes.forEach((n, i) => { nodeIndex[n.id] = i; });

    // Draw edges
    for (const edge of edges) {
      const si = nodeIndex[edge.source];
      const ti = nodeIndex[edge.target];
      if (si === undefined || ti === undefined) continue;
      const weight = Math.min(edge.weight || 1, 5);
      const alpha = Math.min(0.15 + weight * 0.12, 0.7);
      ctx.strokeStyle = `rgba(148, 163, 184, ${alpha})`;
      ctx.lineWidth = Math.max(0.5, Math.min(weight * 0.6, 2.5));
      ctx.beginPath();
      ctx.moveTo(positions[si].x, positions[si].y);
      ctx.lineTo(positions[ti].x, positions[ti].y);
      ctx.stroke();
    }

    // Draw nodes
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const pos = positions[i];
      const isPage = node.type === "page";
      const color = getCommunityColor(node.community ?? -1);
      const radius = isPage ? 5 : Math.min(3 + (node.frequency || 1) * 0.5, 8);
      const isHovered = hoveredNode === i;

      // Glow for hovered node
      if (isHovered) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
      }

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isHovered ? "#ffffff" : color;
      ctx.fill();

      if (isPage) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.shadowBlur = 0;

      // Label for hovered node or keyword nodes when not too many
      if (isHovered) {
        const label = node.label || node.title || node.id.replace(/^(kw:|page:)/, "");
        const displayLabel = label.length > 30 ? label.slice(0, 30) + "…" : label;
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "bold 11px 'DM Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(displayLabel, pos.x, pos.y - radius - 6);
      } else if (!isPage && nodes.length < 40) {
        // Show labels for keyword nodes on small graphs
        const label = node.label || node.id.replace("kw:", "");
        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px 'DM Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, pos.x, pos.y + radius + 12);
      }
    }

    // Stats overlay
    ctx.fillStyle = "#64748b";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${nodes.length} nodes · ${edges.length} edges · ${graphData.community_count || 0} communities`, 8, h - 8);

  }, [graphData, hoveredNode]);

  // Mouse hover detection
  const handleMouseMove = useCallback((e) => {
    if (!layoutRef.current || !graphData) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);

    let closest = -1;
    let closestDist = 20; // hover radius in px
    for (let i = 0; i < layoutRef.current.length; i++) {
      const dx = layoutRef.current[i].x - mx;
      const dy = layoutRef.current[i].y - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    setHoveredNode(closest >= 0 ? closest : null);
  }, [graphData]);

  // Resize canvas to container
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="graph-view">
      <canvas
        ref={canvasRef}
        className="graph-view__canvas"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredNode(null)}
      />
    </div>
  );
}
