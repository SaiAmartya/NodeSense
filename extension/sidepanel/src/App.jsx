import { useState, useEffect } from "react";

function App() {
    const [pageData, setPageData] = useState(null);

    useEffect(() => {
        // Listen for page data messages from the background service worker
        const handleMessage = (message) => {
            if (message.type === "pageData" && message.data) {
                setPageData(message.data);
            }
        };

        chrome.runtime.onMessage.addListener(handleMessage);

        // On mount, check if there's already stored page data
        chrome.storage.session.get("latestPageData", (result) => {
            if (result.latestPageData) {
                setPageData(result.latestPageData);
            }
        });

        // Also request a fresh scrape from the current active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0] && tabs[0].id) {
                chrome.tabs.sendMessage(tabs[0].id, { action: "scrape" }).catch(() => { });
            }
        });

        return () => {
            chrome.runtime.onMessage.removeListener(handleMessage);
        };
    }, []);

    if (!pageData) {
        return (
            <div className="container">
                <div className="header">
                    <h1>NodeSense</h1>
                </div>
                <p className="empty-state">No active page detected.</p>
            </div>
        );
    }

    return (
        <div className="container">
            <div className="header">
                <h1>NodeSense</h1>
            </div>

            <div className="section">
                <h2 className="label">Website Title:</h2>
                <p className="title-value">{pageData.title}</p>
            </div>

            <div className="section">
                <h2 className="label">Website Description:</h2>
                <div className="description-box">
                    <p>{pageData.description}</p>
                </div>
            </div>
        </div>
    );
}

export default App;
