/**
 * NodeSense — StatusBar Component
 *
 * Displays: logo, backend connection dot, Nano AI badge, active task preview.
 */

import React from "react";

export default function StatusBar({ connected, nanoAvailable, activeTask }) {
  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__logo">⬡ NodeSense</span>
        <span
          className={`status-bar__dot ${
            connected ? "status-bar__dot--connected" : "status-bar__dot--disconnected"
          }`}
          title={connected ? "Backend connected" : "Backend offline"}
        />
      </div>
      <div className="status-bar__badges">
        {nanoAvailable && (
          <span className="badge badge--nano" title="Chrome Built-in AI active">
            NANO
          </span>
        )}
        <span className="badge badge--api" title="Gemini API fallback">
          API
        </span>
      </div>
    </div>
  );
}
