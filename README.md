# PDF Converser

Electron desktop app for reading PDFs with voice/text annotations and
LLM-assisted Q&A across the whole document. Highlight a passage, speak or
type your thought, and an LLM cleans it up and classifies it (summary,
critique, strength, question, related work, suggestion, follow-up). All
notes for a PDF travel with the document via a content-hash filename, so
moving or renaming the file never loses its annotations.

Runs fully offline once configured with a local model provider — no
external backend required.

## Run

```
npm install
npm start
```

`npm install` triggers a `postinstall` step that downloads the ~40 MB Vosk
speech model into `models/` so live transcription works offline. If the
download fails, install continues and you can retry with
`npm run fetch-vosk-model`.

Then `File → Open PDF…` (`Ctrl+O`) or drag a PDF onto the window.
`File → Open Recent` lists recently opened files.

## How It Works

1. Open a PDF — pdf.js renders it with a selectable text layer.
2. Highlight text — a small floating toolbar appears with two buttons.
3. **Voice**: click the microphone, speak your annotation, and click
   **Done**. Speech is transcribed (Whisper or Vosk, depending on
   settings), optionally cleaned by the LLM, and saved.
4. **Text**: click the text button, type your annotation, and press
   **Submit** (or `Ctrl+Enter`). By default text is also cleaned by the
   LLM — uncheck "Clean up with LLM" to save it as-is.
5. Annotated text is highlighted in the PDF in a color matching the
   comment type. Click a highlight to jump to that note in the side
   panel; click a note in the panel to scroll the PDF to its passage.

### Asking Questions

You can ask questions about the entire paper from within either the voice
or text annotation workflow:

1. Highlight text (optional — provides context).
2. Open the voice or text input as usual.
3. Speak or type your question, then click **Ask** (or
   `Ctrl+Shift+Enter` in text mode).
4. The answer appears in an overlay, drawing on the full document text.

The full text of each PDF is extracted and stored on first open, so Q&A
covers the whole document, not just the highlighted passage.

### Viewing Annotations

The right pane shows all annotations for the current PDF in one of four
modes:

- **By Page Order** — chronological, grouped by page number
- **By Type** — grouped by comment type
- **By Section** — LLM infers paper sections (Introduction, Methods, …)
- **By Theme** — LLM groups by intellectual theme

Click **Export MD** to download all annotations as a Markdown file.

### Comment Types

The LLM auto-classifies each annotation:

| Type         | Color  | Use case                                       |
|--------------|--------|------------------------------------------------|
| Summary      | Blue   | Restating what the text says                   |
| Critique     | Red    | Identifying weaknesses or disagreements        |
| Strength     | Green  | Noting something positive or well-done         |
| Question     | Orange | Expressing confusion or asking something       |
| Related Work | Purple | Connecting to other papers or ideas            |
| Suggestion   | Teal   | Proposing improvements or alternatives         |
| Follow-up    | Yellow | Things to investigate later                    |

## Settings (`File → Settings…`, `Ctrl/Cmd+,`)

Text and speech are configured independently.

**Text** — used for cleanup, organize, classification, and Q&A:
- OpenAI · Anthropic · Ollama · OpenAI-compatible (Groq, OpenRouter,
  Together, LM Studio, vLLM, llama.cpp server, …). Each provider keeps
  its own credentials with a Test button. Ollama's Test also lists
  installed models.
- Global "Use LLM to clean up annotations" toggle. When off, annotations
  are saved verbatim with a heuristic type label and no LLM call is made
  on creation. Q&A and Organize still need a configured provider.

**Speech** — for voice annotations:
- **OpenAI Whisper** — uses the OpenAI key from the Text section.
- **Local Whisper** — `Xenova/whisper-tiny.en` runs in the renderer via
  WebAssembly (`@huggingface/transformers`, loaded from jsdelivr).
  ~75 MB downloaded from huggingface.co on first record, then cached.
  Audio never leaves the machine.
- **Vosk (raw)** — fully offline via the bundled model. Lowercase, no
  punctuation. Pair with cleanup off to keep raw output, or leave cleanup
  on to have the LLM polish it.
- **Off** — hides the microphone button.

Vosk is also used by every speech mode to drive the *live* partial
transcript shown while recording (Electron's Chromium ships without the
Google Speech key needed by `webkitSpeechRecognition`). The model is
preloaded in the background at startup so the first mic click is instant.

## Note Storage

Annotations are stored as JSON files under the OS-standard per-user app
data directory:

- Windows: `%APPDATA%/pdf-converser-desktop/notes/`
- macOS: `~/Library/Application Support/pdf-converser-desktop/notes/`
- Linux: `~/.config/pdf-converser-desktop/notes/`

Each PDF gets its own files, named by the SHA-256 hash of the first 64KB
of its content (`{hash}.json` for notes, `{hash}.text.json` for the
extracted full text, `{hash}.qa.json` for Q&A history). This means:

- **Rename-proof** — moving or renaming a PDF doesn't lose its notes;
  same content always produces the same hash.
- **Human-readable** — notes are plain JSON, easy to inspect or
  version-control.
- **O(1) lookup** — the hash maps directly to the filename; no index
  needed.

## Layout

- `main.js` — Electron main process. Creates the window, builds the menu,
  registers the `pdfc://` protocol handler, and dispatches IPC.
- `preload.js` — Exposes `window.desktop` (settings, IPC), shims the
  `chrome.*` APIs the renderer scripts under `viewer/`, `content/`,
  `sidebar/`, and `lib/` still use, and intercepts every `fetch` to
  `http://localhost:8000/api/*` to route through `api-stub.js`.
- `app.html` — Split-pane layout: PDF viewer on the left, notes/Q&A
  sidebar on the right. Loads the renderer scripts plus the speech
  runtimes under `services/`.
- `start.html` — Initial blank window with an Open button.
- `settings.html` — Settings UI (text + speech).
- `api-stub.js` — In-process router for the 13 backend HTTP routes the
  renderer fetches at `http://localhost:8000/api/*`.

### Renderer (`viewer/`, `content/`, `sidebar/`, `lib/`)

- `viewer/` — pdf.js wrapper plus the toolbar/page CSS. `viewer/pdfjs/`
  vendors `pdf.min.mjs` and `pdf.worker.min.mjs`.
- `content/` — selection detection, floating action button, voice
  recording overlay, in-PDF highlight rendering.
- `sidebar/` — notes list, organization views (page / type / section /
  theme), question history, Markdown export.
- `lib/` — shared modules: `api-client.js` (fetch wrapper for the
  in-process API), `speech.js` (`SpeechCapture` — MediaRecorder + live
  transcript via Vosk), `pdf-identifier.js` (content hash + page
  number helpers).

### Services (in-process equivalents of the old Python backend)

`services/` holds the implementations behind `api-stub.js`. Same on-disk
schema (`{hash}.json`, `{hash}.text.json`, `{hash}.qa.json`) as the
previous Python backend, so existing notes can be migrated by copy.

- `note-store.js`, `document-store.js`, `qa-store.js` — fs-backed
  persistence under `app.getPath('userData')/notes/`.
- `cleanup-service.js`, `organize-service.js`, `qa-service.js`,
  `transcribe-service.js` — LLM-driven note cleanup, grouping, document
  Q&A, and audio transcription.
- `export-service.js` — Markdown export.
- `llm-service.js` — provider-agnostic `chat()` wrapper. OpenAI &
  OpenAI-compatible via the `openai` SDK; Anthropic via
  `@anthropic-ai/sdk`; Ollama via plain `fetch` to its `/api/chat`.
- `settings-store.js` — settings persistence + migration of legacy fields.
- `recent-files.js` — JSON-backed recent-PDFs list.
- `local-whisper-runtime.js` — renderer-side, exposes
  `window.__localWhisper.transcribe(blob)`.
- `vosk-runtime.js` — renderer-side, exposes `window.__voskRecognition`
  (a `SpeechRecognition`-shaped class). The bundled model is loaded
  from `pdfc://local/app/models/…` so the app stays offline.

### Resources

- `models/vosk-model-small-en-us-0.15.tar.gz` — bundled Vosk model
  (downloaded by `scripts/download-vosk-model.js` on `npm install`).
- `scripts/download-vosk-model.js` — postinstall fetcher; idempotent and
  non-fatal on failure.

## Future Ideas

Not currently implemented; tracked here for future development.

### Full-Document Context Extensions

The full PDF text is already extracted page-by-page on every open and is
used for Q&A. Other features can build on this stored text:

- **Cross-referencing** — when you comment on a result, the LLM links it
  back to the method or measure that produced it. Comment on a claim in
  the Discussion and it finds the supporting data in Results.
- **Context-aware annotation cleanup** — include document context in the
  cleanup prompt so the LLM resolves ambiguous references and classifies
  comment types more accurately.
- **Accurate section detection** — use real section headers from the
  full text to make the "By Section" view exact instead of guessing
  from note snippets.
- **Citation-aware related work** — when you make a "related work"
  annotation, surface the matching citation from the references section.
- **Auto-generated paper summary** — produce a structured summary of the
  paper to provide context alongside annotations in exports.
- **RAG for long documents** — add embedding-based retrieval for papers
  that exceed the LLM's context window.

### Review-Oriented Export

Add export templates tailored to specific workflows:

- **Review export** — generate a structured review (Summary, Strengths,
  Weaknesses with subsections), using `review-examples/` as style/tone
  references so the output matches the user's writing voice.
- **Notes export** — organize annotations by topic/theme for personal
  reference. The "By Theme" view + Markdown export covers part of this;
  a dedicated notes-oriented template could improve the structure.

### Review Rubric Upload & Coverage Check

Allow users to upload review instructions/rubrics (e.g. a conference
review form covering novelty, rigor, clarity, related work,
reproducibility):

- **Coverage report** — compare existing annotations against the
  rubric's categories, highlight under-addressed dimensions. Available
  as a sidebar button at any time.
- **Export-time coverage check** — when a rubric is uploaded, run the
  coverage check on **Export** and surface gaps before exporting.
- **Structured review generation** — organize the review export by the
  rubric's categories rather than a generic format.

## Issues to address

- After clicking **Done** on a comment, the modal sometimes re-spawns
  next to where the mouse was. It should only spawn on highlight; likely
  a fix is to disable the click/highlight detector on submit.
- The annotation modal currently appears in other web pages too when
  text is highlighted; should be restrained to the PDF.

## Other ideas

- Rework the comment-type deduction — switch to multi-tag classification
  since comments often span categories. Also include section context
  (methods, background, etc.) as part of the tag set.
- Default to a yellow highlight but let users change the color via a
  small color icon on each note in the panel.
- The "Ask" feature feels under-developed for this version — consider
  hiding it from the UI while keeping the codepath, to revisit later.
