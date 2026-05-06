# PDF Converser Desktop (Electron)

Phase 1 skeleton: launches an Electron window that loads the existing
`extension/viewer/viewer.html` to render PDFs via pdf.js. Backend wiring,
sidebar, and notes are stubbed (the `chrome.*` shim in `preload.js` is a no-op)
and will be replaced incrementally per the plan at
`~/.claude/plans/thinking-of-re-working-this-elegant-cocke.md`.

## Run

```
cd desktop
npm install
npm start
```

Then `File → Open PDF…` (or `Ctrl+O`) and pick a PDF.

## Layout

- `main.js` — Electron main process. Creates the window, builds the menu, opens
  the PDF picker, navigates the renderer to `app.html` with the chosen file.
- `preload.js` — Exposes a `chrome.*` shim and a `desktop.*` IPC bridge so the
  extension code runs unchanged. `chrome.runtime.getURL`/`storage.local` are
  shimmed; `chrome.runtime.sendMessage`/`onMessage` are wired up as a real
  same-page pub/sub so content.js and sidebar.js can talk directly. The
  service-worker-mediated `getCurrentPdfId` is short-circuited to read
  `window.__pdfContentHash` (with a 5s wait while viewer.js computes it).
- `app.html` — Split-pane layout hosting the existing `extension/viewer/`
  toolbar+pages on the left and `extension/sidebar/` markup on the right.
  Loads the existing viewer/lib/content/sidebar scripts in order; CSS layout
  overrides re-anchor `viewer.css`'s position:fixed rules to the left pane.
- `services/recent-files.js` — JSON-backed list of recently opened PDFs.
- `start.html` — Initial blank window with an Open button.
- `api-stub.js` — In-process implementation of the 13 backend routes.
  Notes / documents / export are real (fs-backed); cleanup, organize, qa,
  and transcribe are still placeholders pending phase 3b (LLM integration).
- `services/note-store.js`, `services/document-store.js`, `services/qa-store.js`,
  `services/export-service.js`, `services/cleanup-service.js`,
  `services/organize-service.js`, `services/qa-service.js`,
  `services/transcribe-service.js` — Node ports of the matching modules
  under `backend/app/`. Same on-disk schema (`{hash}.json`, `{hash}.text.json`,
  `{hash}.qa.json`) as the Python backend, so notes/qa can be migrated by
  copy.
- `services/llm-service.js` — provider-agnostic `chat()` wrapper. OpenAI via
  the `openai` SDK; Ollama via plain `fetch` to its `/api/chat` endpoint.
- `services/settings-store.js`, `settings.html` — settings persistence and
  UI for choosing provider, API key, and model.

## Known gaps for skeleton

- The Python backend is **not** required. `preload.js` intercepts every
  `fetch` to `http://localhost:8000/api/*` and routes it over IPC to
  `api-stub.js` in the main process.
- Notes, document text, and markdown export are now persistent — they live in
  `app.getPath('userData')/notes/` (Windows: `%APPDATA%/pdf-converser-desktop/notes/`,
  macOS: `~/Library/Application Support/pdf-converser-desktop/notes/`,
  Linux: `~/.config/pdf-converser-desktop/notes/`). Files use the same
  `{content_hash}.json` schema as the Python backend; existing notes can be
  migrated by copy.
- Settings (File → Settings…, Ctrl/Cmd+,) split text and speech independently:
  - **Text**: OpenAI · Anthropic · Ollama · OpenAI-compatible (Groq, OpenRouter,
    Together, LM Studio, vLLM, llama.cpp server, …). Each provider has its
    own credentials and a Test button. Ollama's Test also lists installed
    models. There's a global "Use LLM to clean up annotations" toggle — when
    off, notes are stored verbatim with a heuristic type label and no LLM
    call is made on note creation. Q&A and Organize still need a provider.
  - **Speech**: OpenAI Whisper · Local Whisper · Off. Local Whisper runs
    `Xenova/whisper-tiny.en` in the renderer via WebAssembly using
    `@huggingface/transformers` (loaded from jsdelivr). First record
    downloads ~75MB of model files from huggingface.co; subsequent records
    use the cached model. Audio never leaves the machine. Off hides the
    microphone button.
- Sidebar isn't wired yet — `chrome.runtime.sendMessage` is still a no-op, so
  the side panel and tab-switch bookkeeping don't apply. In-PDF highlights and
  note creation work because they happen entirely inside the viewer window.
