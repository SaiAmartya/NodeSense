/**
 * NodeSense — Service Worker (Background Script)
 *
 * Message broker between content scripts ↔ side panel.
 * Backend HTTP communication with intelligent rate limiting.
 *
 * KEY DESIGN:
 *   - Page visits are queued and processed one-at-a-time to prevent flooding.
 *   - Gemini Nano (Chrome Built-in AI) handles keyword extraction on-device.
 *   - Backend receives pre-extracted keywords (or raw content as fallback).
 *   - Gemini 2.5 Flash is used server-side ONLY for contextual chat responses.
 */

const BACKEND_URL = "http://localhost:8000";

// ── Rate Limiting ─────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 5000;       // ignore same URL within 5s
const MIN_INTERVAL_MS = 3000;   // minimum 3s between backend calls
let lastProcessedUrl = "";
let lastProcessedTime = 0;
let processing = false;         // mutex: only one analysis at a time
const pendingQueue = [];        // queue of page visits waiting

// ── Gemini Nano (Chrome Built-in AI) ─────────────────────────────────────────

let nanoSession = null;   // base session with system prompt — cloned per extraction
let nanoAvailable = false;

/**
 * Initialize Gemini Nano for on-device keyword extraction.
 * Creates a reusable base session with a system prompt.
 * Called once on service worker startup.
 */
async function initNano() {
  try {
    // LanguageModel is the global Prompt API namespace in Chrome Extensions
    if (typeof LanguageModel === "undefined") {
      console.log("[NodeSense] Prompt API not available in this browser");
      nanoAvailable = false;
      return;
    }

    const availability = await LanguageModel.availability();
    if (availability === "unavailable") {
      console.log("[NodeSense] Gemini Nano not available (hardware/OS requirements not met)");
      nanoAvailable = false;
      return;
    }

    if (availability === "after-download") {
      console.log("[NodeSense] Gemini Nano model downloading…");
    }

    nanoSession = await LanguageModel.create({
      initialPrompts: [
        {
          role: "system",
          content:
            "You are a keyword extraction engine for a browsing knowledge graph. " +
            "Given web page content, extract 3-5 concise, lowercase topic keywords or short phrases. " +
            "Always respond with ONLY a JSON array of strings, no explanation.",
        },
      ],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          console.log(`[NodeSense] Nano model download: ${Math.round(e.loaded * 100)}%`);
        });
      },
    });

    nanoAvailable = true;
    console.log("[NodeSense] Gemini Nano initialized for keyword extraction");

    // Broadcast availability to any connected side panels
    broadcastToSidePanel({ type: "NANO_STATUS", nanoAvailable: true });
  } catch (err) {
    console.warn("[NodeSense] Failed to initialize Gemini Nano:", err.message);
    nanoAvailable = false;
  }
}

/**
 * Extract keywords from page content using Gemini Nano.
 * Clones the base session for each call to keep extractions stateless.
 * Returns an array of keywords, or null if extraction fails.
 */
async function extractKeywordsWithNano(title, content) {
  if (!nanoSession) return null;

  const truncated = content.slice(0, 1500); // Nano has a smaller context window
  const prompt =
    `Extract 3-5 key topic keywords from this web page.\n` +
    `Return ONLY a JSON array of lowercase strings.\n\n` +
    `Title: ${title}\n` +
    `Content:\n${truncated}`;

  const responseSchema = {
    type: "array",
    items: { type: "string" },
  };

  let clone = null;
  try {
    // Clone the base session so each extraction is independent
    clone = await nanoSession.clone();
    const result = await clone.prompt(prompt, {
      responseConstraint: responseSchema,
    });

    // Parse the structured JSON response
    const keywords = JSON.parse(result);
    if (Array.isArray(keywords) && keywords.length > 0) {
      return keywords
        .map((k) => String(k).toLowerCase().trim())
        .filter(Boolean)
        .slice(0, 5);
    }
  } catch (err) {
    console.warn("[NodeSense] Nano extraction failed:", err.message);

    // If the base session is bad, destroy and reinitialize
    if (err.name === "InvalidStateError" || err.message.includes("destroyed")) {
      nanoSession = null;
      nanoAvailable = false;
      initNano(); // attempt recovery in background
    }
  } finally {
    // Always clean up the clone
    if (clone) {
      try {
        clone.destroy();
      } catch {}
    }
  }

  return null;
}

// Kick off Nano initialization on service worker startup
initNano();

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
    timestamp: pageData.timestamp || Date.now() / 1000,
  };

  // ── Extraction strategy ──────────────────────────────────────────────
  // Primary:  Gemini Nano (on-device, free, fast)
  // Fallback: Send raw content → backend heuristic extraction
  if (nanoAvailable && nanoSession) {
    const keywords = await extractKeywordsWithNano(
      pageData.title,
      pageData.content,
    );
    if (keywords) {
      payload.keywords = keywords;
      payload.content = "";  // no need to send raw content
      console.log("[NodeSense] Nano extracted:", keywords.join(", "));
    } else {
      // Nano failed for this page — fall back to backend extraction
      payload.content = pageData.content;
    }
  } else {
    // No Nano — backend will use heuristic fallback
    payload.content = pageData.content;
  }

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
        nanoAvailable: nanoAvailable,
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
