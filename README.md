# PDF Converser

Electron desktop app for reading and reviewing PDFs with voice/text
annotations, LLM-assisted Q&A across the whole document, and a
review-writing workflow (rubrics, coverage checks, and generated review
drafts). Highlight a passage, speak or type your thought, and an LLM
cleans it up and classifies it (summary, critique, strength, question,
related work, suggestion, follow-up). All notes for a PDF travel with the
document via a content-hash filename, so moving or renaming the file
never loses its annotations.

Runs fully offline once configured with a local model provider, and has a
dedicated offline mode for working with no LLM at all — notes queue up
and get cleaned later.

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
covers the whole document, not just the highlighted passage. Past
questions and answers live in the sidebar's **Questions** tab.

### Viewing Annotations

The sidebar's **Notes** tab shows all annotations for the current PDF in
one of four modes:

- **By Page Order** — chronological, grouped by page number
- **By Type** — grouped by comment tag (a multi-tagged note appears under each
  of its tags)
- **By Section** — grouped by the paper section assigned at note creation
  (Introduction, Methods, …)
- **By Theme** — LLM groups by intellectual theme

Each note offers inline editing of the cleaned text, tag add/remove,
a section pill, a color swatch, delete, and a per-note **Clean /
Re-clean** button. **Export MD** / **Export JSON** download all
annotations; **Check Review** runs the rubric coverage check (below).

### Comment Types

The LLM tags each annotation with one or more of these categories (most get a
single tag; comments that span categories list each one) and identifies the
paper section the passage is in:

| Tag          | Color  | Use case                                       |
|--------------|--------|------------------------------------------------|
| Summary      | Blue   | Restating what the text says                   |
| Critique     | Red    | Identifying weaknesses or disagreements        |
| Strength     | Green  | Noting something positive or well-done         |
| Question     | Orange | Expressing confusion or asking something       |
| Related Work | Purple | Connecting to other papers or ideas            |
| Suggestion   | Teal   | Proposing improvements or alternatives         |
| Follow-up    | Yellow | Things to investigate later                    |

The highlight color in the PDF tracks the primary (first) tag. To override it
per-note, click the small color circle in the note's actions row and pick a
different color (or **Reset** to revert to the tag color).

### In-Text Citation Lookup

On open, the reference list at the end of the paper is parsed
(deterministically, no LLM) and in-text citation markers like `[3]` or
`[1-4, 7]` become clickable. Clicking one opens a modal with the
reference's title, authors, year, venue, and abstract, fetched from
Semantic Scholar (OpenAlex fills in missing abstracts; a Google Scholar
search link is the fallback), plus a **Jump to reference** button that
scrolls to the bibliography entry. Lookups happen only on click and are
cached per PDF.

### References Tab

A per-PDF list of related references (authors / title / link) you
maintain by hand. Entries are fed to the cleanup LLM as context so
"related work" annotations can name the right papers, and are included
in generated reviews so they can be cited verbatim.

### Rubric and Review Tabs

For writing a structured review of the paper:

- **Rubric** — build a list of rubric sections (e.g. a conference review
  form: novelty, rigor, clarity, …) by hand, or **Paste Rubric Text** to
  have the LLM extract structured items from a pasted form. Rubrics can
  be saved as named templates (**Save as…**) and loaded into other
  papers (**Load saved rubric…**).
- **Check Review** (Notes tab toolbar) — the LLM compares your
  annotations against the rubric and reports each component as covered /
  partial / missing, with the supporting notes and a one-line gap
  summary. The result is saved per PDF and can be re-run any time.
- **Review** — **Generate Review** drafts a full review from the
  manuscript text, your annotations, the rubric, and the References tab
  entries (cited verbatim where relevant), following the note context,
  additional instructions, and writing style guide configured in
  Settings. Output streams into the panel with the model's reasoning in
  a collapsible Thinking feed; when done, the draft opens in an editable
  panel with the model's commentary kept in a read-only "Model
  commentary" box above it. **Save** always opens a save dialog,
  defaulting to `<paper>_review.md` in the same folder as the PDF. The
  draft (and commentary) persist per PDF, and the saved `.md` file is
  treated as the canonical copy on reload.

## Offline Mode

Toggle the **Offline** button in the sidebar header (right corner, next
to the tabs) — or the checkbox in Settings — when working without
connectivity. While it's on:

- No LLM or cloud call is ever made (this includes local Ollama, for
  predictability). Q&A, Organize, Check Review, Generate Review, style
  guide generation, and citation lookup are unavailable and fail fast
  with a clear message.
- Voice notes are transcribed locally: Local Whisper if its model is
  already cached, otherwise the bundled Vosk live transcript. Nothing is
  downloaded and nothing leaves the machine.
- Notes (voice or typed) are saved with the raw transcript verbatim and
  marked **Pending cleanup**.

Back online, turn the toggle off and click **Clean pending (N)** in the
Notes toolbar: pending notes are sent to the LLM one at a time, each card
updating as it completes. Typed notes saved with "Clean up with LLM"
unchecked keep their text verbatim — they only get tags and a section
assigned. Failures leave the note pending; each note also has its own
**Clean** button.

## Settings (`File → Settings…`, `Ctrl/Cmd+,`)

Five tabs. Text and speech are configured independently; the review
generator has its own provider so a stronger model can draft reviews.

**Text Processing** — used for cleanup, organize, classification, and Q&A:
- **Offline mode** toggle (same setting as the sidebar button).
- "Use LLM to clean up annotations" toggle. When off, annotations are
  saved verbatim with a heuristic type label and no LLM call is made on
  creation. Q&A and Organize still need a configured provider.
- Provider: OpenAI · Anthropic · Ollama · OpenAI-compatible (Groq,
  OpenRouter, Together, LM Studio, vLLM, llama.cpp server, …). Each
  provider keeps its own credentials with a Test button that also lists
  available models.

**Speech-to-Text** — for voice annotations:
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

**Review** — provider/model/credentials for review generation (an
Autofill button copies the Text Processing keys), plus:
- **Review Style** — an example reviews folder (.txt/.md files of your
  past reviews) and a **Generate style guide** button: the review model
  analyzes the examples and writes an actionable style guide (voice,
  tone, structure, length, formatting) straight into the style guide
  textarea. The result is saved immediately, replacing the previous
  guide, and an "Examples last processed" timestamp is kept. The style
  guide — not the raw examples — is what drafted reviews follow, and it
  stays local to your machine (settings.json), never in the repo.
- **Review Instructions** — two textareas with shipped defaults: *Note
  context* (describes the annotation JSON fields, references, and rubric
  sent with each request) and *Additional instructions* (tone, format,
  and process guidance, e.g. merging comments that revisit earlier
  ones). Blank either one to fall back to the defaults. The app saves
  the review file itself; instructions telling the model to write files
  are ignored.

**References** — optional Semantic Scholar API key for citation lookups
(the keyless shared pool works at low volume; a key raises rate limits).

**User Interface** — auto-color highlights by comment type.

## Note Storage

Annotations are stored as JSON files under the OS-standard per-user app
data directory:

- Windows: `%APPDATA%/pdf-converser-desktop/notes/`
- macOS: `~/Library/Application Support/pdf-converser-desktop/notes/`
- Linux: `~/.config/pdf-converser-desktop/notes/`

Each PDF gets its own files, named by the SHA-256 hash of the first 64KB
of its content:

- `{hash}.json` — notes
- `{hash}.text.json` — extracted full text
- `{hash}.qa.json` — Q&A history
- `{hash}.refs.json` — user references
- `{hash}.rubric.json` — rubric items
- `{hash}.review.json` — rubric coverage check
- `{hash}.review-draft.json` — generated review draft
- `{hash}.citations.json` — parsed citations + lookup cache

`rubric-templates.json` (named reusable rubrics) lives alongside them;
`recent-files.json` and `settings.json` sit at the `userData` root. This
scheme means:

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
  `sidebar/`, and `lib/` still use, intercepts every `fetch` to
  `http://localhost:8000/api/*` to route through `api-stub.js`, and
  handles local-Whisper routing plus offline-mode gating for transcription.
- `app.html` — Split-pane layout: PDF viewer on the left, notes/Q&A
  sidebar on the right. Loads the renderer scripts plus the speech
  runtimes under `services/`.
- `start.html` — Initial window with an Open button and recent files.
- `settings.html` — Settings UI (five tabs, see above).
- `api-stub.js` — In-process router for the ~35 backend HTTP routes the
  renderer fetches at `http://localhost:8000/api/*` (notes, Q&A,
  organize, export, transcribe, references, rubric + templates, review
  check, review generate, citations).

### Renderer (`viewer/`, `content/`, `sidebar/`, `lib/`)

- `viewer/` — pdf.js wrapper plus the toolbar/page CSS and in-PDF find
  bar (`Ctrl+F`). `viewer/pdfjs/` vendors `pdf.min.mjs` and
  `pdf.worker.min.mjs`.
- `content/` — selection detection, floating action button, voice
  recording overlay, in-PDF highlight rendering, citation markers +
  lookup modal.
- `sidebar/` — the five tabs (notes list with four organization views,
  questions, references, rubric, review), offline toggle, pending-notes
  queue, Markdown/JSON export.
- `lib/` — shared modules: `api-client.js` (fetch wrapper for the
  in-process API), `speech.js` (`SpeechCapture` — MediaRecorder + live
  transcript via Vosk), `pdf-identifier.js` (content hash + page
  number helpers).

### Services (in-process equivalents of the old Python backend)

`services/` holds the implementations behind `api-stub.js`. Same on-disk
schema as the previous Python backend, so existing notes can be migrated
by copy.

- Stores (fs-backed persistence under `app.getPath('userData')/notes/`):
  `note-store.js`, `document-store.js`, `qa-store.js`,
  `references-store.js`, `rubric-store.js`, `rubric-templates-store.js`,
  `citations-store.js`, `review-check-store.js`,
  `review-generate-store.js`.
- LLM-driven: `cleanup-service.js` (note cleanup + multi-tag/section
  classification), `organize-service.js` (grouping), `qa-service.js`
  (document Q&A), `rubric-extract-service.js` (parse pasted rubric
  text), `review-check-service.js` (rubric coverage judgment),
  `review-generate-service.js` (streamed review drafting),
  `style-guide-service.js` (distill example reviews into the writing
  style guide).
- Citations: `citation-extract-service.js` (deterministic bibliography
  parsing), `scholar-lookup-service.js` (Semantic Scholar metadata),
  `openalex-service.js` (abstract fallback), `reference-parse.js`
  (DOI/arXiv/title extraction helpers).
- `transcribe-service.js` — speech-to-text routing (cloud Whisper path).
- `export-service.js` — Markdown export.
- `llm-service.js` — provider-agnostic `chat()` wrapper. OpenAI &
  OpenAI-compatible via the `openai` SDK; Anthropic via
  `@anthropic-ai/sdk`; Ollama via plain `fetch` to its `/api/chat`.
  Blocks every call while offline mode is on.
- `settings-store.js` — settings persistence + migration of legacy fields.
- `recent-files.js` — JSON-backed recent-PDFs list.
- `local-whisper-runtime.js` — renderer-side, exposes
  `window.__localWhisper` (`transcribe(blob)`, `isModelCached()`).
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
used for Q&A, cleanup context, and review generation. Other features can
build on this stored text:

- **Cross-referencing** — when you comment on a result, the LLM links it
  back to the method or measure that produced it. Comment on a claim in
  the Discussion and it finds the supporting data in Results.
- **Accurate section detection** — use real section headers from the
  full text to make the "By Section" view exact instead of guessing
  from note snippets.
- **Auto-generated paper summary** — produce a structured summary of the
  paper to provide context alongside annotations in exports.
- **RAG for long documents** — add embedding-based retrieval for papers
  that exceed the LLM's context window.

### Notes-Oriented Export

Organize annotations by topic/theme for personal reference. The "By
Theme" view + Markdown export covers part of this; a dedicated
notes-oriented template could improve the structure.

### Review claim check
- check each critique made in the review. if it makes some claim, is that claim appropriately supported? e.g., if it says, "there is related work on XYZ", does the review provide citations to support this? or if it says, "there is not enough engagement with the literature in this discussion section", how many references are included in that section of the text?
  (The current **Check Review** feature judges rubric *coverage*; this
  would verify the *claims* inside a drafted review.)
