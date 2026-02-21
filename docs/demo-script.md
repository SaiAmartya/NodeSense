# NodeSense — MathHacks Demo Script (~3 minutes)

> **Format:** Screen recording with voiceover. Timings are approximate targets per section.

---

## [0:00–0:30] The Problem & Solution (30s)

**VISUAL:** Quick cut — browser with 20 tabs, then a ChatGPT prompt where the user is typing three paragraphs of context. Then cut to NodeSense's side panel already showing the inferred task.

**VOICEOVER:**

> You just spent an hour deep in research — docs, Stack Overflow, GitHub — and now you need AI help. So what do you do? You open ChatGPT and spend another five minutes explaining everything you just read. Your browser watched you learn it all in real time, but your AI? Completely in the dark.
>
> What if your AI already knew? NodeSense is a Chrome extension that passively builds a **knowledge graph** of your browsing and uses **Bayesian inference** to figure out what you're working on — before you type a single word. No copy-pasting context. No re-explaining. Your AI just *knows*.

---

## [0:30–1:00] Use Case & Why Knowledge Graphs (30s)

**VISUAL:** Open the NodeSense side panel. Show the 3D graph visualization with labeled clusters forming in real time. Highlight two distinct communities — e.g., "React Development" and "Backend API."

**VOICEOVER:**

> Here's what that looks like. As I browse React docs, hooks tutorials, and Stack Overflow threads, NodeSense extracts keywords from each page and connects them in a weighted graph. Pages that share topics get linked. Topics that co-occur get stronger edges.
>
> Why a knowledge graph instead of just stuffing chat history into a prompt? Because **structure matters.** A flat list of visited URLs tells you nothing. But a graph reveals *clusters* — groups of tightly connected pages that represent a coherent task. NodeSense finds these clusters automatically, and that's where the math comes in.

---

## [1:00–1:40] The Flow — How It Works (40s)

**VISUAL:** Animated diagram of the pipeline: Content Script → Gemini Nano → Backend → Graph Update → Louvain → Bayesian Inference → Context Injection → Chat. Highlight each stage as it's described.

**VOICEOVER:**

> Here's the pipeline. When you visit a page, a content script scrapes the text. **Gemini Nano** — Google's on-device AI — extracts keywords right in your browser, for free, with zero latency. Those keywords are sent to our Python backend running **LangGraph**.
>
> The backend does four things in sequence: First, it updates a **NetworkX knowledge graph** — adding page nodes, keyword nodes, and weighted edges. Second, it applies **temporal decay** — older edges fade over time, so recent activity matters more, just like human memory. Third, it runs **Louvain community detection** to discover task clusters. And fourth, it runs **Bayesian inference** to determine which cluster you're most likely working in right now.
>
> That inferred context then gets injected into every chat response — browsing trajectory, topic relationships, cross-cluster bridges — giving the AI deep, structured understanding of your work.

---

## [1:40–2:20] The Math — Probability & Statistics (40s)

**VISUAL:** Show the ContextView panel with the probability bar chart. Overlay simplified formulas as they're mentioned. Show the confidence score updating as new pages are visited.

**VOICEOVER:**

> Let's talk about the math — this is a probability hackathon after all. Each cluster detected by Louvain represents a possible task. We treat this as a Bayesian inference problem: given the keywords on your current page, which task are you most likely working on?
>
> We compute a **prior** — how active each task cluster has been, weighted by temporal decay. Then a **likelihood** — how much the current page's keywords overlap with each cluster. Multiply them together, normalize, and you get a **posterior probability distribution** over tasks.
>
> The system also uses **Laplace smoothing** so no task ever gets a zero probability, and **Shannon entropy** to measure confidence. Low entropy means the system is sure; high entropy means you're multi-tasking across topics. If confidence drops below 25%, it honestly says "Exploring" instead of guessing.

---

## [2:20–2:50] Future Extensions (30s)

**VISUAL:** Mockup slides or quick UI concepts showing tool-use capabilities.

**VOICEOVER:**

> Where we're headed next: **browser-based tools.** Imagine NodeSense not just understanding your context, but acting on it — opening relevant documentation when you switch tasks, searching your bookmarks based on inferred intent, or auto-organizing your tabs into task groups matching the detected communities.
>
> We're also exploring **agentic workflows** — the AI could proactively pull in relevant code snippets from GitHub repos you've visited, or surface related Stack Overflow answers before you even search. The knowledge graph becomes the memory layer for a true browsing agent.

---

## [2:50–3:00] Closing (10s)

**VISUAL:** NodeSense logo, side panel showing active context + chat in action.

**VOICEOVER:**

> NodeSense — a mathematically grounded approach to context-aware AI. Knowledge graphs, Bayesian inference, and on-device AI, working together so your assistant finally understands what you're working on. Thank you.

---

## Production Notes

- **Total estimated word count:** ~520 words (~2:50–3:10 at natural pace)
- **Key visuals to prepare:**
  1. Browser with many tabs open (problem shot)
  2. Live 3D graph visualization in the side panel
  3. Pipeline flow diagram (animated if possible)
  4. ContextView probability bars updating live
  5. Simplified formula overlays (Bayes' rule, decay equation)
  6. Future extensions mockup slides
  7. Logo/closing card
- **Tip:** For the live demo, pre-browse 10–15 pages across 2–3 distinct topics to seed the graph before recording
