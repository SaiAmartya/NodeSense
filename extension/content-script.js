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

  const MAX_CONTENT_LENGTH = 8000;

  // ── Site-specific extractors ───────────────────────────────────────────

  /**
   * Google Docs renders document text deep inside the editor canvas.
   * The DOM structure varies by Docs version, so we try multiple strategies
   * in priority order, targeting only the actual document body.
   *
   * Everything else — outline panel, toolbar, account menu, sharing bar,
   * language pickers, accessibility banners — must be excluded.
   */
  function extractGoogleDocsContent() {
    // Strategy 1: Canvas-based Docs (newer versions)
    // The actual pages live inside .kix-page elements
    const pages = document.querySelectorAll(".kix-page");
    if (pages.length > 0) {
      const lines = [];
      pages.forEach((page) => {
        // Get all text runs within the page
        const textRuns = page.querySelectorAll(
          ".kix-wordhtmlgenerator-word-node, .kix-lineview-text-block"
        );
        if (textRuns.length > 0) {
          textRuns.forEach((run) => {
            const t = (run.innerText || run.textContent || "").trim();
            if (t) lines.push(t);
          });
        } else {
          // Fallback: grab all text from the page element itself
          const t = (page.innerText || "").trim();
          if (t) lines.push(t);
        }
      });
      if (lines.length > 0) return lines.join(" ");
    }

    // Strategy 2: Paragraph renderers (classic Docs DOM)
    const paragraphs = document.querySelectorAll(".kix-paragraphrenderer");
    if (paragraphs.length > 0) {
      const lines = [];
      paragraphs.forEach((p) => {
        const t = (p.innerText || "").trim();
        if (t) lines.push(t);
      });
      if (lines.length > 0) return lines.join("\n");
    }

    // Strategy 3: Line views
    const lineViews = document.querySelectorAll(".kix-lineview");
    if (lineViews.length > 0) {
      const lines = [];
      lineViews.forEach((lv) => {
        const t = (lv.innerText || "").trim();
        if (t) lines.push(t);
      });
      if (lines.length > 0) return lines.join("\n");
    }

    // Strategy 4: The editor container itself, stripping all non-content
    const editorContainer =
      document.querySelector(".kix-appview-editor") ||
      document.querySelector(".kix-paginateddocumentplugin");
    if (editorContainer) {
      // Clone and strip known sidebar/toolbar elements within
      const clone = editorContainer.cloneNode(true);
      clone.querySelectorAll(
        "[role='toolbar'], [role='navigation'], [role='menubar'], " +
        "[role='menu'], [role='dialog'], [role='complementary'], " +
        ".docs-companion-app-container, .navigation-widget-renderer, " +
        ".kix-appview-editor-container > :not(.kix-page-paginated)"
      ).forEach((el) => el.remove());
      const text = (clone.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length > 50) return text;
    }

    // Strategy 5: Any contenteditable area (last resort within Docs)
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) {
      const text = (editable.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length > 50) return text;
    }

    return null; // signal: use generic extractor
  }

  /**
   * Google Slides / Sheets and other Google Workspace apps.
   */
  function extractGoogleWorkspaceContent() {
    // Slides: text content in SVG text elements or punch-viewer
    const slidesText = document.querySelectorAll(
      ".punch-viewer-content [class*='text'], svg text"
    );
    if (slidesText.length > 0) {
      const lines = [];
      slidesText.forEach((el) => {
        const t = (el.innerText || el.textContent || "").trim();
        if (t) lines.push(t);
      });
      if (lines.length > 0) return lines.join("\n");
    }

    // Sheets: grab cell content from the active sheet
    const cells = document.querySelectorAll(".cell-input");
    if (cells.length > 0) {
      const lines = [];
      cells.forEach((c) => {
        const t = (c.innerText || "").trim();
        if (t) lines.push(t);
      });
      if (lines.length > 0) return lines.join(" | ");
    }

    return null;
  }

  /**
   * Notion renders content inside blocks.
   */
  function extractNotionContent() {
    const blocks = document.querySelectorAll(
      "[data-block-id] [contenteditable='true'], .notion-page-content"
    );
    if (blocks.length > 0) {
      const lines = [];
      blocks.forEach((b) => {
        const t = (b.innerText || "").trim();
        if (t) lines.push(t);
      });
      if (lines.length > 0) return lines.join("\n");
    }
    return null;
  }

  // ── Generic extractor ──────────────────────────────────────────────────

  /**
   * Extract meaningful text from the page body.
   * Strips scripts, styles, nav, footer, and collapses whitespace.
   */
  function extractGenericContent() {
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
      "[role='toolbar']",
      "[role='menubar']",
      "[role='menu']",
      "[role='dialog']",
      "[role='complementary']",
      "[role='tablist']",
      "[role='alert']",
      "[aria-label='Document outline']",
      "[aria-label='Outline']",
      ".sidebar",
      ".menu",
      ".nav",
      ".ad",
      ".advertisement",
      ".toolbar",
      ".dropdown",
      // Google Workspace UI noise
      "#docs-chrome",
      "#docs-toolbar",
      "#docs-header",
      "#gb",
      ".docs-titlebar-container",
      ".docs-menubar",
      ".docs-material-gm-pickers",
      ".goog-toolbar",
      ".goog-menu",
      ".goog-menubar",
      ".docs-explore-widget",
      ".navigation-widget-renderer",
      ".docs-companion-app-container",
      ".docs-butterbar-container",
      ".docs-presence-plus-collab-caret-holders",
      ".docs-omnibox",
      ".docs-docos-caret-rewrite-widget",
      ".docs-docos-rewrite-widget",
      ".docs-gm-sharebutton",
      ".docs-revisions-notification-bar",
      ".waffle-comments-panel",
      ".outline-widget",
      // Sharing / account / accessibility banners
      "[data-tooltip]",
      ".docs-share-pane",
      ".gb_Td",
      ".docs-accessibility-bar",
      // Generic popups / overlays
      "[class*='popup']",
      "[class*='modal']",
      "[class*='overlay']",
    ];
    noisySelectors.forEach((sel) => {
      try {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      } catch (_) {
        // Invalid selector – skip
      }
    });

    // Get text content, collapse whitespace
    let text = clone.innerText || clone.textContent || "";
    text = text.replace(/\s+/g, " ").trim();

    return text;
  }

  // ── Main extraction router ─────────────────────────────────────────────

  function extractPageContent() {
    const hostname = window.location.hostname;
    const url = window.location.href;
    let content = null;

    // Google Docs
    if (hostname === "docs.google.com" && url.includes("/document/")) {
      content = extractGoogleDocsContent();
    }
    // Google Slides
    else if (hostname === "docs.google.com" && url.includes("/presentation/")) {
      content = extractGoogleWorkspaceContent();
    }
    // Google Sheets
    else if (hostname === "docs.google.com" && url.includes("/spreadsheets/")) {
      content = extractGoogleWorkspaceContent();
    }
    // Notion
    else if (hostname.includes("notion.so") || hostname.includes("notion.site")) {
      content = extractNotionContent();
    }

    // Fall back to generic extraction
    if (!content || content.length < 30) {
      content = extractGenericContent();
    }

    return (content || "").slice(0, MAX_CONTENT_LENGTH);
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
  // Google Docs is a heavy SPA — wait for the document canvas to render.
  const isGoogleDocs = window.location.hostname === "docs.google.com";
  const delay = isGoogleDocs ? 4000 : 500;
  setTimeout(reportPageVisit, delay);
})();
