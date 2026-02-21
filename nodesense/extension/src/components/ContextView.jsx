/**
 * NodeSense — ContextView Component
 *
 * Shows the inferred active task, keyword tags, confidence score,
 * and a probability bar chart for all detected communities.
 */

import React from "react";

export default function ContextView({ context }) {
  if (!context) {
    return (
      <div className="context-view">
        <div className="context-view__header">
          <span className="context-view__label">Active Context</span>
        </div>
        <div className="context-view__task">Waiting for data…</div>
        <div className="context-view__keywords">
          <span className="keyword-tag">Browse some pages to build your graph</span>
        </div>
      </div>
    );
  }

  const {
    active_task = "Exploring",
    keywords = [],
    confidence = 0,
    communities = [],
  } = context;

  const confidencePct = Math.round(confidence * 100);

  return (
    <div className="context-view">
      <div className="context-view__header">
        <span className="context-view__label">Active Context</span>
        {confidence > 0 && (
          <span className="context-view__confidence">{confidencePct}%</span>
        )}
      </div>

      <div className="context-view__task">{active_task}</div>

      {keywords.length > 0 && (
        <div className="context-view__keywords">
          {keywords.map((kw) => (
            <span key={kw} className="keyword-tag">
              {kw}
            </span>
          ))}
        </div>
      )}

      {communities.length > 0 && (
        <div className="communities">
          {communities.map((c, idx) => (
            <div key={idx} className="community-row">
              <span className="community-row__label" title={c.label}>
                {c.label}
              </span>
              <div className="community-row__bar-track">
                <div
                  className="community-row__bar-fill"
                  style={{ width: `${Math.round(c.probability * 100)}%` }}
                />
              </div>
              <span className="community-row__prob">
                {Math.round(c.probability * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
