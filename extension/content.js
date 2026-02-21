// content.js — Scrapes page title and visible text

// Listen for scrape requests from the background service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "scrape") {
        const pageData = {
            title: document.title || "Untitled",
            description: document.body ? document.body.innerText : ""
        };

        chrome.runtime.sendMessage({
            type: "pageData",
            data: pageData
        });
    }
});

// Also scrape immediately when the content script loads
(() => {
    const pageData = {
        title: document.title || "Untitled",
        description: document.body ? document.body.innerText : ""
    };

    chrome.runtime.sendMessage({
        type: "pageData",
        data: pageData
    }).catch(() => {
        // Side panel may not be open yet — that's fine
    });
})();
