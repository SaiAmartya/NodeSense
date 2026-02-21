/**
 * NodeSense — DataFlowView Component
 *
 * Visualizes the real-time data flow pipeline from content script
 * through Nano extraction → backend analysis → task inference.
 * Each pipeline run is shown as a vertical timeline of animated steps
 * with expandable output previews.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";

// ── Step metadata (icons + descriptions for each pipeline stage) ────────────

const STEP_META = {
  content_received: {
    icon: "📄",
    phase: "extension",
    description: "DOM content scraped by content script",
    order: 0,
  },
  nano_extraction: {
    icon: "🧠",
    phase: "extension",
    description: "On-device keyword extraction via Gemini Nano",
    order: 1,
  },
  backend_submit: {
    icon: "📡",
    phase: "network",
    description: "Payload transmitted to FastAPI backend",
    order: 2,
  },
  backend_processing: {
    icon: "⚙️",
    phase: "backend",
    description: "Full LangGraph pipeline execution",
    order: 3,
  },
  extract_entities: {
    icon: "🔑",
    phase: "backend",
    description: "Entity/keyword extraction (Nano or heuristic)",
    order: 4,
  },
  generate_summary: {
    icon: "📝",
    phase: "backend",
    description: "Page summary generation for graph storage",
    order: 5,
  },
  update_graph: {
    icon: "🕸️",
    phase: "backend",
    description: "NetworkX knowledge graph mutation",
    order: 6,
  },
  detect_communities: {
    icon: "🔬",
    phase: "backend",
    description: "Louvain community detection algorithm",
    order: 7,
  },
  infer_task: {
    icon: "🎯",
    phase: "backend",
    description: "Bayesian posterior computation → task inference",
    order: 8,
  },
};

const PHASE_COLORS = {
  extension: "var(--accent)",
  network: "var(--accent-warm)",
  backend: "var(--info)",
};

// ── Utility: format duration ────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function truncateUrl(url, maxLen = 50) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const display = u.hostname + (path.length > 1 ? path : "");
    return display.length > maxLen ? display.slice(0, maxLen) + "…" : display;
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen) + "…" : url;
  }
}

// ── OutputPreview: renders step output data ─────────────────────────────────

function OutputPreview({ data }) {
  if (!data) return <span className="dfv-output__empty">No output captured</span>;

  if (typeof data === "string") {
    return <pre className="dfv-output__text">{data}</pre>;
  }

  if (Array.isArray(data)) {
    return (
      <div className="dfv-output__array">
        {data.map((item, i) => (
          <span key={i} className="dfv-output__tag">{String(item)}</span>
        ))}
      </div>
    );
  }

  // Object: render as key-value pairs
  return (
    <div className="dfv-output__kv">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="dfv-output__kv-row">
          <span className="dfv-output__key">{key}</span>
          <span className="dfv-output__value">
            {Array.isArray(value) ? (
              <span className="dfv-output__inline-array">
                {value.slice(0, 8).map((v, i) => (
                  <span key={i} className="dfv-output__mini-tag">{String(v)}</span>
                ))}
                {value.length > 8 && <span className="dfv-output__more">+{value.length - 8}</span>}
              </span>
            ) : typeof value === "object" && value !== null ? (
              <span className="dfv-output__nested">{JSON.stringify(value).slice(0, 100)}</span>
            ) : typeof value === "number" ? (
              <span className="dfv-output__number">{
                Number.isInteger(value) ? value : value.toFixed(4)
              }</span>
            ) : (
              <span className="dfv-output__string">{String(value).slice(0, 120)}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── StepCard: individual pipeline step ──────────────────────────────────────

function StepCard({ step, index, isLast, animDelay }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STEP_META[step.name] || {
    icon: "⬡",
    phase: "backend",
    description: step.label || step.name,
    order: 99,
  };
  const phaseColor = PHASE_COLORS[meta.phase] || "var(--text-muted)";

  const statusClass =
    step.status === "completed" ? "dfv-step--completed" :
    step.status === "running" ? "dfv-step--running" :
    step.status === "skipped" ? "dfv-step--skipped" :
    step.status === "failed" ? "dfv-step--failed" : "";

  return (
    <div
      className={`dfv-step ${statusClass}`}
      style={{ animationDelay: `${animDelay}ms` }}
    >
      {/* Connector line */}
      {!isLast && <div className="dfv-step__connector" style={{ borderColor: phaseColor }} />}

      {/* Node dot */}
      <div className="dfv-step__node" style={{ borderColor: phaseColor, color: phaseColor }}>
        <span className="dfv-step__icon">{meta.icon}</span>
      </div>

      {/* Content */}
      <div
        className="dfv-step__content"
        onClick={() => step.output_preview && setExpanded(!expanded)}
      >
        <div className="dfv-step__header">
          <div className="dfv-step__label-row">
            <span className="dfv-step__label">{step.label || step.name}</span>
            <span className="dfv-step__phase" style={{ color: phaseColor }}>
              {meta.phase}
            </span>
          </div>
          <div className="dfv-step__meta-row">
            <span className="dfv-step__duration">
              {step.status === "running" ? (
                <span className="dfv-step__running-indicator">
                  <span className="dfv-step__pulse" />
                  Processing…
                </span>
              ) : (
                formatDuration(step.duration_ms)
              )}
            </span>
            {step.status === "skipped" && (
              <span className="dfv-step__skip-badge">SKIPPED</span>
            )}
            {step.status === "failed" && (
              <span className="dfv-step__fail-badge">FAILED</span>
            )}
            {step.output_preview && (
              <span className="dfv-step__expand-hint">
                {expanded ? "▾" : "▸"}
              </span>
            )}
          </div>
        </div>

        <p className="dfv-step__description">{meta.description}</p>

        {expanded && step.output_preview && (
          <div className="dfv-step__output">
            <OutputPreview data={step.output_preview} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── PipelineRun: one complete pipeline execution ────────────────────────────

function PipelineRun({ run, isLatest }) {
  const [collapsed, setCollapsed] = useState(!isLatest);

  // Merge extension steps and backend steps into unified timeline
  const allSteps = [];

  // Add extension-side steps
  if (run.extension_steps) {
    for (const step of run.extension_steps) {
      // Skip the generic "backend_processing" step if we have detailed backend steps
      if (step.name === "backend_processing" && run.backend_steps && run.backend_steps.length > 0) {
        continue;
      }
      allSteps.push(step);
    }
  }

  // Add detailed backend steps if available
  if (run.backend_steps) {
    for (const step of run.backend_steps) {
      allSteps.push(step);
    }
  }

  // Sort by order if known, else by started_at
  allSteps.sort((a, b) => {
    const orderA = STEP_META[a.name]?.order ?? 99;
    const orderB = STEP_META[b.name]?.order ?? 99;
    return orderA - orderB;
  });

  const statusIcon =
    run.status === "completed" ? "✓" :
    run.status === "running" ? "◉" :
    run.status === "failed" ? "✗" : "○";

  const statusClass =
    run.status === "completed" ? "dfv-run--completed" :
    run.status === "running" ? "dfv-run--running" :
    run.status === "failed" ? "dfv-run--failed" : "";

  return (
    <div className={`dfv-run ${statusClass} ${isLatest ? "dfv-run--latest" : ""}`}>
      <button
        className="dfv-run__header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="dfv-run__header-left">
          <span className={`dfv-run__status-icon dfv-run__status-icon--${run.status}`}>
            {statusIcon}
          </span>
          <div className="dfv-run__info">
            <span className="dfv-run__title">
              {run.title || truncateUrl(run.url)}
            </span>
            <span className="dfv-run__url">{truncateUrl(run.url, 60)}</span>
          </div>
        </div>
        <div className="dfv-run__header-right">
          <span className="dfv-run__time">{formatTime(run.started_at)}</span>
          {run.duration_ms != null && (
            <span className="dfv-run__total-duration">{formatDuration(run.duration_ms)}</span>
          )}
          <span className="dfv-run__chevron">{collapsed ? "▸" : "▾"}</span>
        </div>
      </button>

      {!collapsed && (
        <div className="dfv-run__steps">
          {allSteps.length === 0 ? (
            <div className="dfv-run__empty">No pipeline steps recorded</div>
          ) : (
            allSteps.map((step, i) => (
              <StepCard
                key={`${step.name}-${i}`}
                step={step}
                index={i}
                isLast={i === allSteps.length - 1}
                animDelay={isLatest ? i * 60 : 0}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── DataFlowView: main component ────────────────────────────────────────────

export default function DataFlowView({ requestPipeline, onMessage }) {
  const [runs, setRuns] = useState([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const containerRef = useRef(null);

  // Listen for pipeline data responses
  useEffect(() => {
    const cleanup = onMessage("PIPELINE_DATA", (msg) => {
      if (msg.runs) {
        setRuns(msg.runs);
      }
    });
    return cleanup;
  }, [onMessage]);

  // Listen for live pipeline updates
  useEffect(() => {
    const cleanup = onMessage("PIPELINE_UPDATE", (msg) => {
      if (msg.run) {
        setRuns((prev) => {
          const existing = prev.findIndex((r) => r.id === msg.run.id);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = msg.run;
            return updated;
          }
          return [msg.run, ...prev].slice(0, 20);
        });
      }
    });
    return cleanup;
  }, [onMessage]);

  // Initial fetch & auto-refresh
  useEffect(() => {
    requestPipeline();

    if (!autoRefresh) return;
    const interval = setInterval(() => {
      requestPipeline();
    }, 5000);
    return () => clearInterval(interval);
  }, [requestPipeline, autoRefresh]);

  const handleRefresh = useCallback(() => {
    requestPipeline();
  }, [requestPipeline]);

  return (
    <div className="dfv" ref={containerRef}>
      {/* Header */}
      <div className="dfv__header">
        <div className="dfv__header-left">
          <span className="dfv__title">Pipeline Flow</span>
          <span className="dfv__subtitle">
            {runs.length} run{runs.length !== 1 ? "s" : ""} tracked
          </span>
        </div>
        <div className="dfv__header-right">
          <button
            className={`dfv__auto-btn ${autoRefresh ? "dfv__auto-btn--active" : ""}`}
            onClick={() => setAutoRefresh(!autoRefresh)}
            title={autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
          >
            {autoRefresh ? "⟳ LIVE" : "⟳ PAUSED"}
          </button>
          <button className="dfv__refresh-btn" onClick={handleRefresh} title="Refresh now">
            ↻
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="dfv__legend">
        <div className="dfv__legend-item">
          <span className="dfv__legend-dot" style={{ background: "var(--accent)" }} />
          <span>Extension</span>
        </div>
        <div className="dfv__legend-item">
          <span className="dfv__legend-dot" style={{ background: "var(--accent-warm)" }} />
          <span>Network</span>
        </div>
        <div className="dfv__legend-item">
          <span className="dfv__legend-dot" style={{ background: "var(--info)" }} />
          <span>Backend</span>
        </div>
      </div>

      {/* Pipeline runs */}
      <div className="dfv__runs">
        {runs.length === 0 ? (
          <div className="dfv__empty">
            <div className="dfv__empty-icon">⬡</div>
            <div className="dfv__empty-title">No pipeline activity yet</div>
            <div className="dfv__empty-subtitle">
              Browse a page to see the data flow pipeline in action.
              Each step of the analysis will appear here in real time.
            </div>
          </div>
        ) : (
          runs.map((run, i) => (
            <PipelineRun
              key={run.id}
              run={run}
              isLatest={i === 0}
            />
          ))
        )}
      </div>
    </div>
  );
}
