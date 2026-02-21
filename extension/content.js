// content.js — Scrapes page title and visible text

/**
 * Extract the main content from the page, preferring semantic elements
 * over the full body to avoid nav, footer, sidebar, ad noise.
 */
function extractPageContent() {
    const title = document.title || "Untitled";

    // Try semantic containers first (most specific → least)
    const selectors = ["article", "main", '[role="main"]'];
    let contentEl = null;

    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 100) {
            contentEl = el;
            break;
        }
    }

    // Fallback to body
    if (!contentEl) {
        contentEl = document.body;
    }

    let text = contentEl ? contentEl.innerText : "";

    // Clean up: collapse 3+ newlines into 2, trim lines
    text = text
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    // Cap at 5000 chars to keep the side panel responsive
    if (text.length > 5000) {
        text = text.slice(0, 5000) + "\n\n[... truncated]";
    }

    return { title, description: text };
}

// Listen for scrape requests from the background service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "scrape") {
        chrome.runtime.sendMessage({
            type: "pageData",
            data: extractPageContent(),
        });
    }
});

// Also scrape immediately when the content script loads
(() => {
    chrome.runtime.sendMessage({
        type: "pageData",
        data: extractPageContent(),
    }).catch(() => {
        // Side panel may not be open yet — that's fine
    });
})();
