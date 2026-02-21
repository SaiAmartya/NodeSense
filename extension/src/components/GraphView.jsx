/**
 * NodeSense — GraphView Component
 *
 * 3D force-directed knowledge graph visualization using Three.js / WebGL.
 * Nodes are colored by community, sized by type/frequency.
 * Edge lengths are inversely proportional to similarity weight —
 * stronger connections pull nodes closer together.
 * Navigate: left-drag orbit, right-drag pan, scroll zoom.
 * Auto-refreshes graph data every 5 seconds.
 */

import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import ForceGraph3D from "react-force-graph-3d";
import * as THREE from "three";

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

// ── Link distance from weight (higher weight = shorter link) ─────────────
const BASE_LINK_DISTANCE = 120;
const MIN_LINK_DISTANCE = 15;

function weightToDistance(weight) {
  // Inverse relationship: similarity ∝ 1/distance
  // Clamp weight to avoid division issues
  const w = Math.max(0.1, Math.min(weight || 1, 10));
  return Math.max(MIN_LINK_DISTANCE, BASE_LINK_DISTANCE / w);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GraphView({ requestGraph, onMessage }) {
  const fgRef = useRef(null);
  const containerRef = useRef(null);
  const [rawData, setRawData] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 400, height: 300 });

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
        setRawData(msg.graph);
      }
    });
    return cleanup;
  }, [onMessage]);

  // Transform backend data → ForceGraph3D format
  const graphData = useMemo(() => {
    if (!rawData || !rawData.nodes || rawData.nodes.length === 0) {
      return { nodes: [], links: [] };
    }

    const nodes = rawData.nodes.map((n) => ({
      id: n.id,
      label: n.label || n.title || n.id.replace(/^(kw:|page:)/, ""),
      type: n.type || (n.id.startsWith("page:") ? "page" : "keyword"),
      community: n.community ?? -1,
      frequency: n.frequency || 1,
      color: getCommunityColor(n.community ?? -1),
    }));

    // Build a node ID set for validation
    const nodeIds = new Set(nodes.map((n) => n.id));

    const links = (rawData.edges || [])
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        weight: e.weight || 1,
        baseWeight: e.base_weight || e.weight || 1,
      }));

    return { nodes, links };
  }, [rawData]);

  // Re-apply force config when graph data changes
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || graphData.nodes.length === 0) return;

    // Give the engine a tick to initialize, then configure forces
    const timer = setTimeout(() => {
      fg.d3Force("link")
        ?.distance((link) => weightToDistance(link.weight))
        .strength((link) => {
          const w = Math.max(0.1, Math.min(link.weight || 1, 10));
          return 0.3 * Math.sqrt(w);
        });

      fg.d3Force("charge")?.strength(-60);

      // Re-heat simulation so new distances apply
      fg.d3ReheatSimulation();
    }, 100);

    return () => clearTimeout(timer);
  }, [graphData]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      setDimensions({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Scene styling + force config on mount
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    // Dark background matching our UI
    fg.scene().background = new THREE.Color("#0a0e17");

    // Softer ambient + directional lights
    const scene = fg.scene();
    scene.children
      .filter((c) => c.isLight)
      .forEach((l) => scene.remove(l));
    const ambient = new THREE.AmbientLight(0xcccccc, 1.0);
    const directional = new THREE.DirectionalLight(0xffffff, 0.6);
    directional.position.set(100, 200, 150);
    scene.add(ambient);
    scene.add(directional);

    // Configure d3 forces — link distance based on weight (similarity)
    fg.d3Force("link")
      ?.distance((link) => weightToDistance(link.weight))
      .strength((link) => {
        const w = Math.max(0.1, Math.min(link.weight || 1, 10));
        return 0.3 * Math.sqrt(w);
      });

    fg.d3Force("charge")?.strength(-60);
    fg.d3Force("center")?.strength(0.05);

    // Initial camera position
    fg.cameraPosition({ x: 0, y: 0, z: 250 });
  }, []);

  // ── Node rendering ─────────────────────────────────────────────────────

  const nodeThreeObject = useCallback((node) => {
    const isPage = node.type === "page";
    const radius = isPage ? 3.5 : Math.min(2 + node.frequency * 0.4, 6);
    const color = new THREE.Color(node.color);

    const group = new THREE.Group();

    // Core sphere
    const geometry = new THREE.SphereGeometry(radius, 20, 20);
    const material = new THREE.MeshPhongMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.25,
      shininess: 60,
      transparent: true,
      opacity: 0.92,
    });
    const sphere = new THREE.Mesh(geometry, material);
    group.add(sphere);

    // Outer glow ring for page nodes
    if (isPage) {
      const ringGeo = new THREE.RingGeometry(radius + 1, radius + 2, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      group.add(ring);
    }

    // Text label (always visible as a sprite)
    const label = node.label.length > 24 ? node.label.slice(0, 24) + "…" : node.label;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const fontSize = 28;
    canvas.width = 256;
    canvas.height = 48;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${fontSize}px 'DM Sans', sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(label, canvas.width / 2, fontSize + 4);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(24, 4.5, 1);
    sprite.position.set(0, radius + 4, 0);
    group.add(sprite);

    return group;
  }, []);

  // ── Link styling ───────────────────────────────────────────────────────

  const linkWidth = useCallback((link) => {
    return Math.max(0.3, Math.min((link.weight || 1) * 0.5, 3));
  }, []);

  const linkColor = useCallback((link) => {
    const alpha = Math.min(0.15 + (link.weight || 1) * 0.12, 0.7);
    return `rgba(148, 163, 184, ${alpha})`;
  }, []);

  // ── Node hover / click ─────────────────────────────────────────────────

  const handleNodeHover = useCallback((node) => {
    if (containerRef.current) {
      containerRef.current.style.cursor = node ? "pointer" : "grab";
    }
  }, []);

  const handleNodeClick = useCallback(
    (node) => {
      // Fly camera to clicked node
      const fg = fgRef.current;
      if (!fg || !node) return;
      const distance = 80;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
      fg.cameraPosition(
        { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
        node,
        1200
      );
    },
    []
  );

  // ── Empty state ────────────────────────────────────────────────────────

  if (!rawData || !rawData.nodes || rawData.nodes.length === 0) {
    return (
      <div className="graph-view" ref={containerRef}>
        <div className="graph-view__empty">
          <span className="graph-view__empty-title">Browse pages to build your graph</span>
          <span className="graph-view__empty-subtitle">
            Nodes and edges appear as you browse
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-view" ref={containerRef}>
      <ForceGraph3D
        ref={fgRef}
        width={dimensions.width}
        height={dimensions.height}
        graphData={graphData}
        // ── Node config ──
        nodeThreeObject={nodeThreeObject}
        nodeThreeObjectExtend={false}
        // ── Link config ──
        linkWidth={linkWidth}
        linkOpacity={1}
        linkColor={linkColor}
        linkDirectionalParticles={0}
        // ── Force engine ──
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        // ── Interaction ──
        onNodeHover={handleNodeHover}
        onNodeClick={handleNodeClick}
        enableNavigationControls={true}
        showNavInfo={false}
        // ── Background ──
        backgroundColor="#0a0e17"
      />
      {/* Stats overlay */}
      <div className="graph-view__stats">
        {graphData.nodes.length} nodes · {graphData.links.length} edges ·{" "}
        {rawData.community_count || 0} communities
      </div>
    </div>
  );
}
