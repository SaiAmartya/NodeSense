/**
 * NodeSense — ChatPanel Component
 *
 * Chat interface with message history, typing indicator, and markdown rendering.
 */

import React, { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";

export default function ChatPanel({
  onSendMessage,
  onClearChat,
  messages,
  isLoading,
  connected,
}) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  function handleSubmit(e) {
    e.preventDefault();
    const query = input.trim();
    if (!query || isLoading) return;

    onSendMessage(query);
    setInput("");
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      handleSubmit(e);
    }
  }

  return (
    <div className="chat-panel">
      {/* Header with new chat button */}
      <div className="chat-panel__header">
        <span className="chat-panel__title">Chat</span>
        <button
          className="chat-panel__new-chat"
          onClick={onClearChat}
          title="Start a new chat"
        >
          + New Chat
        </button>
      </div>

      <div className="chat-panel__messages">
        {messages.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">⬡</div>
            <div className="empty-state__title">Ask NodeSense anything</div>
            <div className="empty-state__subtitle">
              Your browsing context is automatically injected into every query.
              Try &ldquo;What am I working on?&rdquo; or &ldquo;Summarize this
              topic.&rdquo;
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div key={idx} className={`message message--${msg.role}`}>
              {msg.role === "assistant" ? (
                <>
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                  {msg.contextUsed && (
                    <span className="message__context-badge">
                      ctx: {msg.contextUsed}
                    </span>
                  )}
                </>
              ) : (
                msg.content
              )}
            </div>
          ))
        )}

        {isLoading && (
          <div className="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          className="chat-input__field"
          type="text"
          placeholder={
            connected
              ? "Ask with context…"
              : "Backend offline — start the server"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
          autoFocus
        />
        <button
          className="chat-input__send"
          type="submit"
          disabled={!input.trim() || isLoading || !connected}
          title="Send"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2L11 13" />
            <path d="M22 2L15 22L11 13L2 9L22 2Z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
