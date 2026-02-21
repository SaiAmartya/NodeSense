/**
 * NodeSense — Content Script
 *
 * Injected into every page at document_idle.
 * Scrapes page metadata (URL, title, body text) and sends it
 * to the service worker for processing.
 *
 * Runs in an ISOLATED world (no access to page JS / LanguageModel API).
 */

(() => {
  "use strict";

  const MAX_CONTENT_LENGTH = 3000;

  /**
   * Extract meaningful text from the page body.
   * Strips scripts, styles, nav, footer, and collapses whitespace.
   */
  function extractPageContent() {
    // Clone body to avoid modifying the live DOM
    const clone = document.body.cloneNode(true);

    // Remove noisy elements
    const noisySelectors = [
      "script",
      "style",
      "noscript",
      "nav",
      "footer",
      "header",
      "aside",
      "iframe",
      "[role='navigation']",
      "[role='banner']",
      "[role='contentinfo']",
      ".sidebar",
      ".menu",
      ".nav",
      ".ad",
      ".advertisement",
    ];
    noisySelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Get text content, collapse whitespace
    let text = clone.innerText || clone.textContent || "";
    text = text.replace(/\s+/g, " ").trim();

    return text.slice(0, MAX_CONTENT_LENGTH);
  }

  /**
   * Send page data to the service worker.
   */
  function reportPageVisit() {
    const payload = {
      type: "PAGE_CONTENT",
      payload: {
        url: window.location.href,
        title: document.title || "",
        content: extractPageContent(),
        timestamp: Date.now() / 1000, // Unix epoch seconds
      },
    };

    try {
      chrome.runtime.sendMessage(payload);
    } catch (err) {
      // Extension context may be invalidated (e.g., extension reloaded)
      console.debug("[NodeSense] Could not send page data:", err.message);
    }
  }

  /**
   * Listen for on-demand scrape requests from the service worker.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "SCRAPE_PAGE") {
      sendResponse({
        url: window.location.href,
        title: document.title || "",
        content: extractPageContent(),
        timestamp: Date.now() / 1000,
      });
      return true; // async response
    }
  });

  // ── Auto-report on load ────────────────────────────────────────────────
  // Small delay to let the page finish rendering dynamic content
  setTimeout(reportPageVisit, 500);
})();
