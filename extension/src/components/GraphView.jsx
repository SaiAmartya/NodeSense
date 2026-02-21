/**
 * NodeSense — GraphView Component
 *
 * 3D force-directed knowledge graph visualization using Three.js / WebGL.
 * Nodes are colored by community, sized by type/frequency.
 * Edge lengths are inversely proportional to similarity weight —
 * stronger connections pull nodes closer together.
 *
 * Features:
 *   - Hover tooltip showing node metadata (type, community, frequency, edges)
 *   - Edge weight labels rendered as mid-link sprites
 *   - Directional particles flowing along edges (speed ∝ weight)
 *   - Smooth camera fly-to on click with gentle orbit controls
 *   - Animated ambient star-field particles in background
 *   - Auto-refreshes graph data every 5 seconds
 *
 * Navigate: left-drag orbit, right-drag pan, scroll zoom.
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
  const w = Math.max(0.1, Math.min(weight || 1, 10));
  return Math.max(MIN_LINK_DISTANCE, BASE_LINK_DISTANCE / w);
}

// ── Create a text sprite (reusable helper) ───────────────────────────────
function makeTextSprite(text, {
  fontSize = 28,
  canvasW = 256,
  canvasH = 48,
  fillStyle = "#e2e8f0",
  fontFamily = "'DM Sans', sans-serif",
  opacity = 0.85,
} = {}) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = canvasW;
  canvas.height = canvasH;
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = fillStyle;
  ctx.fillText(text, canvasW / 2, canvasH / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity,
  });
  return new THREE.Sprite(mat);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GraphView({ requestGraph, resetGraph, onMessage }) {
  const fgRef = useRef(null);
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const [rawData, setRawData] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 400, height: 300 });
  const [tooltip, setTooltip] = useState(null); // { x, y, node?, link? }
  const [hoveredNode, setHoveredNode] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null); // detail panel

  // ── Data fetching ──────────────────────────────────────────────────────

  useEffect(() => {
    requestGraph();
    const interval = setInterval(requestGraph, 5000);
    return () => clearInterval(interval);
  }, [requestGraph]);

  useEffect(() => {
    const cleanup = onMessage("GRAPH_DATA", (msg) => {
      if (msg.graph) setRawData(msg.graph);
    });
    return cleanup;
  }, [onMessage]);

  // Listen for reset confirmation
  useEffect(() => {
    const cleanup = onMessage("GRAPH_RESET", (msg) => {
      setResetting(false);
      if (msg.success) setRawData(null);
    });
    return cleanup;
  }, [onMessage]);

  const handleReset = useCallback(() => {
    if (resetting) return;
    setResetting(true);
    resetGraph();
  }, [resetGraph, resetting]);

  // ── Transform backend data → ForceGraph3D format ───────────────────────

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
      visitCount: n.visit_count || 0,
      color: getCommunityColor(n.community ?? -1),
      // Rich data for detail panel
      summary: n.summary || "",
      contentSnippet: n.content_snippet || "",
      url: n.url || "",
      title: n.title || "",
      pageRefs: n.page_refs || [],
    }));

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

  // ── Precompute per-node edge counts for tooltip ────────────────────────

  const nodeEdgeCounts = useMemo(() => {
    const counts = {};
    for (const link of graphData.links) {
      const sid = typeof link.source === "object" ? link.source.id : link.source;
      const tid = typeof link.target === "object" ? link.target.id : link.target;
      counts[sid] = (counts[sid] || 0) + 1;
      counts[tid] = (counts[tid] || 0) + 1;
    }
    return counts;
  }, [graphData]);

  // ── Force configuration ────────────────────────────────────────────────

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || graphData.nodes.length === 0) return;
    const timer = setTimeout(() => {
      fg.d3Force("link")
        ?.distance((link) => weightToDistance(link.weight))
        .strength((link) => {
          const w = Math.max(0.1, Math.min(link.weight || 1, 10));
          return 0.3 * Math.sqrt(w);
        });
      fg.d3Force("charge")?.strength(-80);
      // Don't reheat — let the simulation settle and stay still
    }, 100);
    return () => clearTimeout(timer);
  }, [graphData]);

  // ── Resize observer ────────────────────────────────────────────────────

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

  // ── Scene setup on mount ───────────────────────────────────────────────

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    fg.scene().background = new THREE.Color("#0a0e17");

    // Lighting
    const scene = fg.scene();
    scene.children.filter((c) => c.isLight).forEach((l) => scene.remove(l));
    const ambient = new THREE.AmbientLight(0xcccccc, 1.0);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.6);
    dir1.position.set(100, 200, 150);
    const dir2 = new THREE.DirectionalLight(0x8888ff, 0.3);
    dir2.position.set(-150, -100, -100);
    scene.add(ambient, dir1, dir2);

    // Star-field background particles
    const starGeo = new THREE.BufferGeometry();
    const starCount = 600;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i++) {
      starPositions[i] = (Math.random() - 0.5) * 1200;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x445566,
      size: 0.6,
      transparent: true,
      opacity: 0.5,
      sizeAttenuation: true,
    });
    const stars = new THREE.Points(starGeo, starMat);
    stars.name = "__nodesense_stars";
    scene.add(stars);

    // Force config
    fg.d3Force("link")
      ?.distance((link) => weightToDistance(link.weight))
      .strength((link) => {
        const w = Math.max(0.1, Math.min(link.weight || 1, 10));
        return 0.3 * Math.sqrt(w);
      });
    fg.d3Force("charge")?.strength(-80);
    fg.d3Force("center")?.strength(0.05);

    // Orbit controls — responsive zoom, no auto-rotation
    const controls = fg.controls();
    if (controls) {
      controls.enableDamping = true;
      controls.dampingFactor = 0.15;
      controls.rotateSpeed = 0.8;
      controls.zoomSpeed = 2.0;
      controls.panSpeed = 0.6;
      controls.minDistance = 10;
      controls.maxDistance = 800;
      controls.autoRotate = false;
    }

    // Initial camera
    fg.cameraPosition({ x: 0, y: 0, z: 250 });
  }, []);

  // ── Arrow key navigation ───────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Make container focusable so it can receive key events
    if (!container.getAttribute("tabindex")) {
      container.setAttribute("tabindex", "0");
      container.style.outline = "none";
    }

    const PAN_STEP = 12;
    const handleKeyDown = (e) => {
      const fg = fgRef.current;
      if (!fg) return;
      const camera = fg.camera();
      const controls = fg.controls();
      if (!camera || !controls) return;

      let dx = 0, dy = 0;
      switch (e.key) {
        case "ArrowLeft":  dx = -PAN_STEP; break;
        case "ArrowRight": dx =  PAN_STEP; break;
        case "ArrowUp":    dy =  PAN_STEP; break;
        case "ArrowDown":  dy = -PAN_STEP; break;
        default: return; // don't prevent default for other keys
      }
      e.preventDefault();

      // Pan the camera in screen space
      const target = controls.target;
      const offset = camera.position.clone().sub(target);
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      camera.getWorldDirection(new THREE.Vector3());
      right.crossVectors(camera.up, offset).normalize();
      up.copy(camera.up).normalize();

      const pan = right.multiplyScalar(dx).add(up.multiplyScalar(dy));
      camera.position.add(pan);
      target.add(pan);
      controls.update();
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── Node rendering ─────────────────────────────────────────────────────

  const nodeThreeObject = useCallback(
    (node) => {
      const isPage = node.type === "page";
      const isHovered = hoveredNode?.id === node.id;
      const baseRadius = isPage ? 3.5 : Math.min(2 + node.frequency * 0.4, 6);
      const radius = isHovered ? baseRadius * 1.35 : baseRadius;
      const color = new THREE.Color(node.color);

      const group = new THREE.Group();

      // Core sphere
      const geo = new THREE.SphereGeometry(radius, 24, 24);
      const mat = new THREE.MeshPhongMaterial({
        color,
        emissive: color,
        emissiveIntensity: isHovered ? 0.55 : 0.25,
        shininess: 80,
        transparent: true,
        opacity: isHovered ? 1.0 : 0.92,
      });
      group.add(new THREE.Mesh(geo, mat));

      // Outer glow shell
      const glowGeo = new THREE.SphereGeometry(radius * 1.5, 16, 16);
      const glowMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: isHovered ? 0.18 : 0.06,
        side: THREE.BackSide,
      });
      group.add(new THREE.Mesh(glowGeo, glowMat));

      // Ring for page nodes
      if (isPage) {
        const ringGeo = new THREE.RingGeometry(radius + 1.2, radius + 2.2, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: isHovered ? 0.4 : 0.15,
          side: THREE.DoubleSide,
        });
        group.add(new THREE.Mesh(ringGeo, ringMat));
      }

      // Label sprite
      const labelText =
        node.label.length > 22 ? node.label.slice(0, 22) + "…" : node.label;
      const sprite = makeTextSprite(labelText, {
        fontSize: 28,
        fillStyle: isHovered ? "#ffffff" : "#e2e8f0",
        opacity: isHovered ? 1.0 : 0.8,
      });
      sprite.scale.set(24, 4.5, 1);
      sprite.position.set(0, radius + 4.5, 0);
      group.add(sprite);

      return group;
    },
    [hoveredNode]
  );

  // ── Link rendering ─────────────────────────────────────────────────────

  const linkThreeObject = useCallback((link) => {
    // Mid-link weight label sprite
    const w = link.weight || 1;
    const label = w.toFixed(2);
    const sprite = makeTextSprite(label, {
      fontSize: 22,
      canvasW: 128,
      canvasH: 32,
      fillStyle: "#94a3b8",
      fontFamily: "'JetBrains Mono', monospace",
      opacity: 0.7,
    });
    sprite.scale.set(10, 2.5, 1);
    return sprite;
  }, []);

  const linkPositionUpdate = useCallback((sprite, { start, end }) => {
    // Position label at midpoint of the link
    const mid = Object.assign(
      ...["x", "y", "z"].map((c) => ({
        [c]: start[c] + (end[c] - start[c]) / 2,
      }))
    );
    Object.assign(sprite.position, mid);
  }, []);

  const linkWidth = useCallback((link) => {
    return Math.max(0.4, Math.min((link.weight || 1) * 0.6, 4));
  }, []);

  const linkColor = useCallback((link) => {
    const w = Math.min(link.weight || 1, 5);
    const alpha = Math.min(0.2 + w * 0.14, 0.85);
    return `rgba(148, 163, 184, ${alpha})`;
  }, []);

  // Particle config — flowing dots along edges, speed ∝ weight
  const linkParticles = useCallback((link) => {
    const w = link.weight || 1;
    if (w < 0.5) return 0;
    return Math.min(Math.ceil(w), 4);
  }, []);

  const linkParticleWidth = useCallback((link) => {
    return Math.max(0.8, Math.min((link.weight || 1) * 0.4, 2.5));
  }, []);

  const linkParticleSpeed = useCallback((link) => {
    const w = Math.max(0.1, link.weight || 1);
    return 0.003 * w;
  }, []);

  const linkParticleColor = useCallback((link) => {
    // Use the source node's community color if available
    const srcNode =
      typeof link.source === "object"
        ? link.source
        : graphData.nodes.find((n) => n.id === link.source);
    return srcNode?.color || "#94a3b8";
  }, [graphData.nodes]);

  // ── Tooltip on hover ───────────────────────────────────────────────────

  const handleNodeHover = useCallback(
    (node, prevNode) => {
      if (containerRef.current) {
        containerRef.current.style.cursor = node ? "pointer" : "grab";
      }
      setHoveredNode(node || null);
      if (!node) {
        setTooltip(null);
        return;
      }
      // We'll position the tooltip via the DOM overlay, not 3D coords
      // The actual position is updated in onNodeHover's mouse event
      const edges = nodeEdgeCounts[node.id] || 0;
      const communityLabel =
        rawData?.community_count != null
          ? `Community ${node.community >= 0 ? node.community : "—"}`
          : "—";
      setTooltip({
        node: {
          label: node.label,
          type: node.type === "page" ? "Page" : "Keyword",
          community: communityLabel,
          communityIdx: node.community,
          frequency: node.frequency,
          visitCount: node.visitCount,
          edges,
        },
      });
    },
    [nodeEdgeCounts, rawData]
  );

  const handleLinkHover = useCallback((link) => {
    if (!link) {
      setTooltip(null);
      return;
    }
    const srcLabel =
      typeof link.source === "object"
        ? link.source.label
        : link.source.replace(/^(kw:|page:)/, "");
    const tgtLabel =
      typeof link.target === "object"
        ? link.target.label
        : link.target.replace(/^(kw:|page:)/, "");
    setTooltip({
      link: {
        source: srcLabel,
        target: tgtLabel,
        weight: link.weight,
        baseWeight: link.baseWeight,
        distance: weightToDistance(link.weight),
      },
    });
  }, []);

  // Track mouse position for tooltip placement
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handler = (e) => {
      if (tooltipRef.current) {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        tooltipRef.current.style.left = `${x + 14}px`;
        tooltipRef.current.style.top = `${y + 14}px`;
      }
    };
    container.addEventListener("mousemove", handler);
    return () => container.removeEventListener("mousemove", handler);
  }, []);

  // ── Click → fly-to ─────────────────────────────────────────────────────

  const handleNodeClick = useCallback((node) => {
    const fg = fgRef.current;
    if (!fg || !node) return;

    // Fly-to animation
    const distance = 60;
    const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z || 1);
    fg.cameraPosition(
      { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
      node,
      1500
    );

    // Show detail panel if this node has rich data
    const hasContent = node.summary || node.contentSnippet || node.url || (node.pageRefs && node.pageRefs.length > 0);
    if (hasContent) {
      setSelectedNode(node);
    } else {
      setSelectedNode(null);
    }
  }, []);

  // ── Empty state ────────────────────────────────────────────────────────

  if (!rawData || !rawData.nodes || rawData.nodes.length === 0) {
    return (
      <div className="graph-view" ref={containerRef}>
        <div className="graph-view__empty">
          <span className="graph-view__empty-icon">&loz;</span>
          <span className="graph-view__empty-title">
            Knowledge graph is empty
          </span>
          <span className="graph-view__empty-subtitle">
            Browse pages to populate nodes and edges. The graph auto-updates
            every 5 seconds.
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
        nodeRelSize={6}
        // ── Link config ──
        linkWidth={linkWidth}
        linkOpacity={1}
        linkColor={linkColor}
        linkThreeObject={linkThreeObject}
        linkThreeObjectExtend={true}
        linkPositionUpdate={linkPositionUpdate}
        linkDirectionalParticles={linkParticles}
        linkDirectionalParticleWidth={linkParticleWidth}
        linkDirectionalParticleSpeed={linkParticleSpeed}
        linkDirectionalParticleColor={linkParticleColor}
        // ── Force engine (settle fast, then freeze) ──
        d3AlphaDecay={0.05}
        d3VelocityDecay={0.4}
        warmupTicks={80}
        cooldownTicks={100}
        cooldownTime={3000}
        // ── Interaction ──
        onNodeHover={handleNodeHover}
        onNodeClick={handleNodeClick}
        onLinkHover={handleLinkHover}
        enableNavigationControls={true}
        showNavInfo={false}
        // ── Background ──
        backgroundColor="#0a0e17"
      />

      {/* ── Tooltip overlay ── */}
      {tooltip && (
        <div
          ref={tooltipRef}
          className="graph-tooltip"
        >
          {tooltip.node && (
            <>
              <div className="graph-tooltip__title">{tooltip.node.label}</div>
              <div className="graph-tooltip__row">
                <span className="graph-tooltip__key">Type</span>
                <span
                  className="graph-tooltip__val"
                  style={{
                    color: getCommunityColor(tooltip.node.communityIdx),
                  }}
                >
                  {tooltip.node.type}
                </span>
              </div>
              <div className="graph-tooltip__row">
                <span className="graph-tooltip__key">Community</span>
                <span className="graph-tooltip__val">
                  {tooltip.node.community}
                </span>
              </div>
              {tooltip.node.type === "Keyword" && (
                <div className="graph-tooltip__row">
                  <span className="graph-tooltip__key">Frequency</span>
                  <span className="graph-tooltip__val">
                    {tooltip.node.frequency}
                  </span>
                </div>
              )}
              {tooltip.node.type === "Page" && tooltip.node.visitCount > 0 && (
                <div className="graph-tooltip__row">
                  <span className="graph-tooltip__key">Visits</span>
                  <span className="graph-tooltip__val">
                    {tooltip.node.visitCount}
                  </span>
                </div>
              )}
              <div className="graph-tooltip__row">
                <span className="graph-tooltip__key">Edges</span>
                <span className="graph-tooltip__val">
                  {tooltip.node.edges}
                </span>
              </div>
            </>
          )}
          {tooltip.link && (
            <>
              <div className="graph-tooltip__title graph-tooltip__title--link">
                {tooltip.link.source}
                <span className="graph-tooltip__arrow">&harr;</span>
                {tooltip.link.target}
              </div>
              <div className="graph-tooltip__row">
                <span className="graph-tooltip__key">Decayed weight</span>
                <span className="graph-tooltip__val graph-tooltip__val--accent">
                  {tooltip.link.weight.toFixed(3)}
                </span>
              </div>
              <div className="graph-tooltip__row">
                <span className="graph-tooltip__key">Base weight</span>
                <span className="graph-tooltip__val">
                  {tooltip.link.baseWeight.toFixed(1)}
                </span>
              </div>
              <div className="graph-tooltip__row">
                <span className="graph-tooltip__key">Similarity</span>
                <span className="graph-tooltip__val graph-tooltip__val--accent">
                  {Math.min(
                    (tooltip.link.weight / Math.max(tooltip.link.baseWeight, 1)) * 100,
                    100
                  ).toFixed(1)}
                  %
                </span>
              </div>
              <div className="graph-tooltip__row">
                <span className="graph-tooltip__key">Link distance</span>
                <span className="graph-tooltip__val">
                  {tooltip.link.distance.toFixed(1)}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Stats bar ── */}
      <div className="graph-view__stats">
        <span className="graph-view__stats-dot" /> Live &nbsp;·&nbsp;{" "}
        {graphData.nodes.length} nodes &nbsp;·&nbsp; {graphData.links.length}{" "}
        edges &nbsp;·&nbsp; {rawData.community_count || 0} communities
      </div>

      {/* ── Reset button ── */}
      <button
        className="graph-view__reset"
        onClick={handleReset}
        disabled={resetting}
        title="Clear all nodes and edges"
      >
        {resetting ? "Clearing…" : "Reset Graph"}
      </button>

      {/* ── Node Detail Panel ── */}
      {selectedNode && (
        <div className="graph-detail">
          <div className="graph-detail__header">
            <div className="graph-detail__type-badge" style={{ background: selectedNode.color }}>
              {selectedNode.type === "page" ? "PAGE" : "KW"}
            </div>
            <div className="graph-detail__title">
              {selectedNode.title || selectedNode.label}
            </div>
            <button
              className="graph-detail__close"
              onClick={() => setSelectedNode(null)}
              title="Close"
            >
              ✕
            </button>
          </div>

          {selectedNode.url && (
            <div className="graph-detail__url">{selectedNode.url}</div>
          )}

          {selectedNode.type === "page" && selectedNode.visitCount > 0 && (
            <div className="graph-detail__meta">
              <span>Visits: {selectedNode.visitCount}</span>
              <span>Community: {selectedNode.community >= 0 ? selectedNode.community : "—"}</span>
            </div>
          )}

          {selectedNode.type === "keyword" && (
            <div className="graph-detail__meta">
              <span>Frequency: {selectedNode.frequency}</span>
              <span>Community: {selectedNode.community >= 0 ? selectedNode.community : "—"}</span>
              {selectedNode.pageRefs.length > 0 && (
                <span>Pages: {selectedNode.pageRefs.length}</span>
              )}
            </div>
          )}

          {selectedNode.summary && (
            <div className="graph-detail__section">
              <div className="graph-detail__section-label">Summary</div>
              <div className="graph-detail__section-body">
                {selectedNode.summary}
              </div>
            </div>
          )}

          {selectedNode.contentSnippet && (
            <div className="graph-detail__section">
              <div className="graph-detail__section-label">Page Content</div>
              <div className="graph-detail__section-body graph-detail__section-body--content">
                {selectedNode.contentSnippet}
              </div>
            </div>
          )}

          {selectedNode.pageRefs && selectedNode.pageRefs.length > 0 && (
            <div className="graph-detail__section">
              <div className="graph-detail__section-label">
                Appears on {selectedNode.pageRefs.length} page{selectedNode.pageRefs.length !== 1 ? "s" : ""}
              </div>
              <div className="graph-detail__page-refs">
                {selectedNode.pageRefs.map((ref, i) => (
                  <div key={i} className="graph-detail__page-ref">
                    {ref}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
