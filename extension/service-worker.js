/**
 * NodeSense — Service Worker (Background Script)
 *
 * Message broker between content scripts ↔ side panel.
 * Backend HTTP communication with intelligent rate limiting.
 *
 * KEY DESIGN: Page visits are queued and processed one-at-a-time
 * to prevent flooding the backend/LLM with concurrent requests.
 */

const BACKEND_URL = "http://localhost:8000";

// ── Rate Limiting ─────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 5000;       // ignore same URL within 5s
const MIN_INTERVAL_MS = 3000;   // minimum 3s between backend calls
let lastProcessedUrl = "";
let lastProcessedTime = 0;
let processing = false;         // mutex: only one analysis at a time
const pendingQueue = [];        // queue of page visits waiting

// ── Backend Communication ────────────────────────────────────────────────────

async function backendPost(endpoint, body) {
  try {
    const resp = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`[NodeSense] Backend ${endpoint} returned ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error(`[NodeSense] Backend ${endpoint} unreachable:`, err.message);
    return null;
  }
}

async function backendGet(endpoint) {
  try {
    const resp = await fetch(`${BACKEND_URL}${endpoint}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.error(`[NodeSense] Backend GET ${endpoint} failed:`, err.message);
    return null;
  }
}

// ── Page Visit Processing (Serial Queue) ─────────────────────────────────────

function enqueuePageVisit(pageData) {
  const now = Date.now();

  // Debounce: skip same URL within 5s
  if (
    pageData.url === lastProcessedUrl &&
    now - lastProcessedTime < DEBOUNCE_MS
  ) {
    return;
  }

  // Skip internal pages
  if (
    pageData.url.startsWith("chrome://") ||
    pageData.url.startsWith("chrome-extension://") ||
    pageData.url.startsWith("about:") ||
    pageData.url.startsWith("devtools://")
  ) {
    return;
  }

  lastProcessedUrl = pageData.url;
  lastProcessedTime = now;

  // Replace any pending item (only the latest unprocessed page matters)
  pendingQueue.length = 0;
  pendingQueue.push(pageData);

  drainQueue();
}

async function drainQueue() {
  if (processing || pendingQueue.length === 0) return;
  processing = true;

  while (pendingQueue.length > 0) {
    const pageData = pendingQueue.shift();
    await processPageVisit(pageData);

    // Minimum gap between backend calls
    if (pendingQueue.length > 0) {
      await sleep(MIN_INTERVAL_MS);
    }
  }

  processing = false;
}

async function processPageVisit(pageData) {
  console.log("[NodeSense] Processing:", (pageData.title || pageData.url).slice(0, 60));

  const payload = {
    url: pageData.url,
    title: pageData.title,
    content: pageData.content,
    timestamp: pageData.timestamp || Date.now() / 1000,
  };

  const result = await backendPost("/api/analyze", payload);

  if (result) {
    await chrome.storage.session.set({ latestContext: result });
    broadcastToSidePanel({ type: "CONTEXT_UPDATE", context: result });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Side Panel Communication ─────────────────────────────────────────────────

const sidePanelPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "nodesense-sidepanel") {
    console.log("[NodeSense] Side panel connected");
    sidePanelPorts.add(port);

    port.onDisconnect.addListener(() => {
      sidePanelPorts.delete(port);
      console.log("[NodeSense] Side panel disconnected");
    });

    port.onMessage.addListener(async (msg) => {
      await handleSidePanelMessage(msg, port);
    });

    // Send current state on connect
    chrome.storage.session.get(["latestContext"], (data) => {
      port.postMessage({
        type: "INIT_STATE",
        context: data.latestContext || null,
        nanoAvailable: false,
      });
    });
  }
});

function broadcastToSidePanel(message) {
  for (const port of sidePanelPorts) {
    try {
      port.postMessage(message);
    } catch (err) {
      sidePanelPorts.delete(port);
    }
  }
}

async function handleSidePanelMessage(msg, port) {
  switch (msg.type) {
    case "CHAT_QUERY": {
      const result = await backendPost("/api/chat", {
        query: msg.query,
        session_id: msg.sessionId || null,
      });
      port.postMessage({
        type: "CHAT_RESPONSE",
        response: result?.response || "Backend unavailable. Is the server running?",
        contextUsed: result?.context_used || "",
      });
      break;
    }

    case "GET_CONTEXT": {
      const ctx = await backendGet("/api/context");
      port.postMessage({ type: "CONTEXT_UPDATE", context: ctx });
      break;
    }

    case "GET_GRAPH": {
      const graph = await backendGet("/api/graph");
      port.postMessage({ type: "GRAPH_DATA", graph });
      break;
    }

    default:
      console.warn("[NodeSense] Unknown side panel message:", msg.type);
  }
}

// ── Message Listener (from content scripts) ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PAGE_CONTENT") {
    enqueuePageVisit(message.payload);
    sendResponse({ received: true });
  }
  return false;
});

// ── Side Panel Toggle ────────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

console.log("[NodeSense] Service worker started");
