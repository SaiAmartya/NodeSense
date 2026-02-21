/**
 * NodeSense — useBackend hook
 *
 * Manages the long-lived port connection to the service worker.
 * Handles sending/receiving messages and maintaining connection state.
 */

import { useState, useEffect, useRef, useCallback } from "react";

export function useBackend() {
  const [connected, setConnected] = useState(false);
  const [context, setContext] = useState(null);
  const [nanoAvailable, setNanoAvailable] = useState(false);
  const portRef = useRef(null);
  const listenersRef = useRef(new Map());

  // ── Connect to service worker ──────────────────────────────────────────

  useEffect(() => {
    let port;

    function connect() {
      try {
        port = chrome.runtime.connect({ name: "nodesense-sidepanel" });
        portRef.current = port;
        setConnected(true);

        port.onMessage.addListener((msg) => {
          handleMessage(msg);
        });

        port.onDisconnect.addListener(() => {
          setConnected(false);
          portRef.current = null;
          // Attempt reconnect after 2s
          setTimeout(connect, 2000);
        });
      } catch (err) {
        console.warn("[NodeSense] Could not connect to service worker:", err);
        setConnected(false);
        setTimeout(connect, 3000);
      }
    }

    function handleMessage(msg) {
      switch (msg.type) {
        case "INIT_STATE":
          setContext(msg.context);
          setNanoAvailable(msg.nanoAvailable || false);
          break;

        case "CONTEXT_UPDATE":
          setContext(msg.context);
          break;

        case "NANO_STATUS":
          setNanoAvailable(msg.nanoAvailable || false);
          break;

        default:
          // Dispatch to registered listeners
          const callback = listenersRef.current.get(msg.type);
          if (callback) callback(msg);
          break;
      }
    }

    connect();

    return () => {
      if (port) {
        try {
          port.disconnect();
        } catch {}
      }
    };
  }, []);

  // ── Send message to service worker ─────────────────────────────────────

  const sendMessage = useCallback((msg) => {
    if (portRef.current) {
      try {
        portRef.current.postMessage(msg);
      } catch (err) {
        console.error("[NodeSense] Failed to send message:", err);
      }
    }
  }, []);

  // ── One-shot listener registration ─────────────────────────────────────

  const onMessage = useCallback((type, callback) => {
    listenersRef.current.set(type, callback);
    return () => listenersRef.current.delete(type);
  }, []);

  // ── High-level API ─────────────────────────────────────────────────────

  const sendChat = useCallback(
    (query, sessionId) => {
      sendMessage({ type: "CHAT_QUERY", query, sessionId });
    },
    [sendMessage]
  );

  const requestContext = useCallback(() => {
    sendMessage({ type: "GET_CONTEXT" });
  }, [sendMessage]);

  const requestGraph = useCallback(() => {
    sendMessage({ type: "GET_GRAPH" });
  }, [sendMessage]);

  const resetGraph = useCallback(() => {
    sendMessage({ type: "RESET_GRAPH" });
  }, [sendMessage]);

  const requestPipeline = useCallback(() => {
    sendMessage({ type: "GET_PIPELINE" });
  }, [sendMessage]);

  return {
    connected,
    context,
    nanoAvailable,
    sendChat,
    requestContext,
    requestGraph,
    resetGraph,
    requestPipeline,
    onMessage,
    sendMessage,
  };
}
