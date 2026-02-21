# AI Strategy

NodeSense's two-tier AI architecture and how each tier contributes to contextual awareness.

---

## Two-Tier Design

NodeSense uses two AI models for fundamentally different purposes:

| Tier | Model | Location | Purpose | Cost |
|------|-------|----------|---------|------|
| **Extraction** | Gemini Nano | On-device (Chrome) | Keyword extraction from pages | Free |
| **Chat** | Gemini 2.5 Flash | Server-side API | Contextual responses to user queries | API calls |

This separation is deliberate: extraction runs on *every page visit* (high frequency, must be free and fast), while chat runs only when the user explicitly asks a question (lower frequency, justifies API cost).

## Tier 1: Gemini Nano (On-Device Extraction)

### What It Does
When the user visits a page, Gemini Nano extracts 3-5 concise topic keywords from the page title and content. These keywords flow into the knowledge graph as nodes.

### How It Works
1. The service worker creates a **base session** on startup with a system prompt tuned for keyword extraction
2. For each page visit, the base session is **cloned** (stateless, avoids context overflow)
3. The clone processes the page content with a `responseConstraint` (JSON Schema) ensuring structured `string[]` output
4. The clone is destroyed after extraction

### Fallback: Heuristic Extraction
When Nano is unavailable (unsupported hardware, model downloading, session failure):
- The extension sends raw page content to the backend
- The backend uses a heuristic: title word extraction + content frequency analysis
- No API calls — purely local string processing

### Key Constraint
**Gemini Nano is ONLY used for extraction, never for chat.** Its context window is limited and it's optimized for short, structured outputs, not conversational responses.

## Tier 2: Gemini 2.5 Flash (Server-Side Chat)

### What It Does
When the user asks a question in the side panel, Gemini Flash generates a context-aware response. It receives the deep GraphRAG context block in its system prompt, giving it genuine understanding of the user's browsing activity.

### What It Receives (Before Enhancement)
```
Active task: React Development
Related topics: react, hooks, state, useEffect, components
Confidence: 87%
```

### What It Receives (After Enhancement)
```
== ACTIVE TASK ==
Task: React Development
Confidence: 87%
Core topics: react, hooks, state, useEffect, components

== RECENT BROWSING TRAJECTORY ==
1. "React Docs - useEffect" (3m ago)
   Summary: Documentation about the useEffect hook lifecycle...
   Topics: react, useEffect, lifecycle
2. "SO: useEffect cleanup" (12m ago)
   Summary: Discussion about preventing memory leaks...

== ACTIVE TASK CLUSTER ==
Cluster size: 12 pages, 18 keywords, 45 connections
Key pages:
  - "React Hooks API Reference" (visited 3x)
    Reference documentation for all built-in React hooks

== TOPIC RELATIONSHIPS ==
  react ↔ hooks (strength: 5.2)
  useEffect ↔ lifecycle (strength: 3.1)

== CROSS-TOPIC CONNECTIONS ==
  "typescript" connects React Development → Backend API
```

The difference is profound. The enhanced context enables the AI to:
- Reference specific pages the user has been reading
- Understand the temporal sequence of their browsing
- Identify relationships between concepts
- Recognize when the user is multi-tasking across topics

### Rate Limiting & Resilience
- **429 errors** trigger a 60-second cooldown (no API calls during cooldown)
- **Retry logic** with exponential backoff (up to 2 retries)
- **Fallback responses** when the API is unavailable, still incorporating context

## Summarization: The Third Function

Page summarization is a critical middle ground — it happens for every page visit but uses **no API calls**:

1. The heuristic summarizer takes the page title + first ~300 chars of content
2. It extracts the first 1-2 coherent sentences
3. The result is stored on the page node in the knowledge graph

This is purely local string processing. The summaries are concise but informative enough to give the chat AI meaningful page-level context.

## Why Not Use Flash for Everything?

1. **Cost**: Flash API calls on every page visit (dozens per hour) would be expensive
2. **Latency**: API calls add 1-3 seconds per page visit, creating noticeable lag
3. **Privacy**: Sending full page content to an API on every visit raises privacy concerns
4. **Reliability**: API rate limits would throttle high-frequency extraction

Nano handles the high-frequency, low-complexity work (keyword extraction) for free on-device, while Flash is reserved for the low-frequency, high-complexity work (contextual chat) where API quality matters.

## Why Not Use Nano for Chat?

1. **Context window**: Nano's context is too small for rich GraphRAG context injection
2. **Response quality**: Nano is optimized for short, structured outputs, not conversational responses
3. **Reasoning**: Flash has significantly stronger reasoning capabilities for synthesizing complex context

## Content Flow

```
Page Visit
    │
    ├─ Nano available ───→ Keywords (Nano) + Content snippet (500 chars) → Backend
    │                        Backend generates summary from snippet
    │
    └─ Nano unavailable ─→ Full content (3000 chars) → Backend
                             Backend extracts keywords (heuristic)
                             Backend generates summary from content

Chat Query
    │
    └─ Always ──→ Cached enriched context → Build context block → Flash API
                   (trajectory, summaries,    (structured prompt     (contextual
                    relationships, bridges)    sections)              response)
```

## System Prompt Philosophy

The system prompt is not a static template — it's **dynamically assembled** from graph state. The `build_context_block()` function constructs the context section from whatever data is available:

- **Rich context** (many pages, high confidence): All five layers included
- **Sparse context** (few pages, low confidence): Only basic task identity
- **No context** (cold start): AI acknowledges it's still learning

This adaptive approach ensures the prompt is always proportional to the available evidence, avoiding both information overload and false sparsity.
