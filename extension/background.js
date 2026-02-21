// background.js — Service Worker for NodeSense Chrome Extension

// Open side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// When a tab finishes loading, ask the content script to scrape the page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    // Skip chrome:// and other internal pages
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      return;
    }

    chrome.tabs.sendMessage(tabId, { action: "scrape" }).catch(() => {
      // Content script may not be injected yet on some pages — ignore
    });
  }
});

// When the user switches tabs, ask the new active tab's content script to scrape
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab && tab.status === "complete" && tab.url) {
      if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
        return;
      }
      chrome.tabs.sendMessage(activeInfo.tabId, { action: "scrape" }).catch(() => {});
    }
  });
});

// Relay page data from content script to any listeners (the side panel)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "pageData") {
    // Store the latest data so the side panel can request it
    chrome.storage.session.set({ latestPageData: message.data });
  }
});
