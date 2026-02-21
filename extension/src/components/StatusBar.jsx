/**
 * NodeSense — StatusBar Component
 *
 * Displays: logo, backend connection dot, AI tier badges, active task preview.
 *
 * Badge meaning:
 *   NANO  — Gemini Nano is active for on-device keyword extraction
 *   FLASH — Gemini 2.5 Flash is the chat/reasoning backend
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
        {nanoAvailable ? (
          <span className="badge badge--nano" title="Gemini Nano — on-device keyword extraction">
            NANO
          </span>
        ) : (
          <span className="badge badge--fallback" title="Nano unavailable — using heuristic extraction">
            HEURISTIC
          </span>
        )}
        <span className="badge badge--flash" title="Gemini 2.5 Flash — contextual chat (server)">
          FLASH
        </span>
      </div>
    </div>
  );
}
