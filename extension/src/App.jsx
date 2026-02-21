/**
 * NodeSense — App Root Component
 *
 * Orchestrates: StatusBar, ContextView/GraphView (tabbed), ChatPanel.
 * Manages chat state and backend communication.
 */

import React, { useState, useEffect, useCallback } from "react";
import StatusBar from "./components/StatusBar";
import ContextView from "./components/ContextView";
import GraphView from "./components/GraphView";
import DataFlowView from "./components/DataFlowView";
import ChatPanel from "./components/ChatPanel";
import { useBackend } from "./hooks/useBackend";

export default function App() {
  const {
    connected,
    context,
    nanoAvailable,
    sendChat,
    requestGraph,
    resetGraph,
    requestPipeline,
    onMessage,
  } = useBackend();

  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("context"); // "context" | "graph" | "visualize"

  // ── Listen for chat responses from the service worker ──────────────────

  useEffect(() => {
    const cleanup = onMessage("CHAT_RESPONSE", (msg) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: msg.response || "No response received.",
          contextUsed: msg.contextUsed || "",
        },
      ]);
      setIsLoading(false);
    });

    return cleanup;
  }, [onMessage]);

  // ── Load chat history from storage on mount ────────────────────────────

  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.get(["chatHistory"], (data) => {
        if (data.chatHistory) {
          setMessages(data.chatHistory);
        }
      });
    }
  }, []);

  // ── Persist chat history on change ─────────────────────────────────────

  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.storage && messages.length > 0) {
      const toSave = messages.slice(-50);
      chrome.storage.local.set({ chatHistory: toSave });
    }
  }, [messages]);

  // ── Send a chat message ────────────────────────────────────────────────

  const handleSendMessage = useCallback(
    (query) => {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: query },
      ]);
      setIsLoading(true);
      sendChat(query);
    },
    [sendChat]
  );

  return (
    <div className="app">
      <StatusBar
        connected={connected}
        nanoAvailable={nanoAvailable}
        activeTask={context?.active_task}
      />

      {/* Tab Bar */}
      <div className="tab-bar">
        <button
          className={`tab-bar__tab ${activeTab === "context" ? "tab-bar__tab--active" : ""}`}
          onClick={() => setActiveTab("context")}
        >
          Context
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "graph" ? "tab-bar__tab--active" : ""}`}
          onClick={() => setActiveTab("graph")}
        >
          Graph
        </button>
        <button
          className={`tab-bar__tab ${activeTab === "visualize" ? "tab-bar__tab--active" : ""}`}
          onClick={() => setActiveTab("visualize")}
        >
          Visualize
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "context" ? (
        <ContextView context={context} />
      ) : activeTab === "graph" ? (
        <GraphView requestGraph={requestGraph} resetGraph={resetGraph} onMessage={onMessage} />
      ) : (
        <DataFlowView requestPipeline={requestPipeline} onMessage={onMessage} />
      )}

      <ChatPanel
        onSendMessage={handleSendMessage}
        messages={messages}
        isLoading={isLoading}
        connected={connected}
      />
    </div>
  );
}
