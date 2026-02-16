# PDF Converser

A Chrome extension + Python backend for annotating academic PDFs with voice notes. Highlight text, speak your thoughts, and an LLM cleans your rambling speech into concise, well-structured annotations.

## How It Works

1. Open a PDF in Chrome — the extension intercepts it and renders it with a selectable text layer
2. Highlight text in the PDF — a blue microphone button appears
3. Click the mic and speak your annotation
4. Your speech is transcribed (Whisper for quality, Web Speech API for live preview)
5. The transcript is sent to an LLM which cleans it up and auto-classifies it (summary, critique, strength, question, related work, suggestion, follow-up)
6. View all your annotations in the Chrome side panel, organized by page, type, section, or theme
7. Export your annotations as Markdown

## Setup

### Backend

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS/Linux
source .venv/bin/activate

pip install -e .

# Configure
cp .env.example .env
# Edit .env and set your OPENAI_API_KEY

# Run
uvicorn app.main:app --reload
```

The backend runs at `http://localhost:8000`. You can verify it's working at `http://localhost:8000/docs` (Swagger UI).

### Chrome Extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked** and select the `extension/` folder
4. Click **Details** on the PDF Converser card and enable **Allow access to file URLs** (if you read local PDFs)

### Configuration (`.env`)

```
OPENAI_API_KEY=sk-your-key-here    # Required for LLM cleanup and Whisper
OPENAI_MODEL=gpt-4o-mini           # Model for cleaning up annotations
LLM_PROVIDER=openai                # "openai" or "ollama"
NOTES_DIR=./notes                  # Where annotation JSON files are stored

# Optional: use Ollama instead
# LLM_PROVIDER=ollama
# OLLAMA_BASE_URL=http://localhost:11434
# OLLAMA_MODEL=llama3.2
```

## Usage

### Adding Annotations

1. Open any PDF in Chrome (local files or web URLs)
2. Highlight a passage of text — a small toolbar appears with two buttons
3. **Voice**: Click the microphone button, speak your annotation, and click **Done**. Your speech is transcribed via Whisper, cleaned by the LLM, and saved.
4. **Text**: Click the text button, type your annotation, and press **Submit** (or Ctrl+Enter). By default, your text is cleaned up by the LLM — uncheck "Clean up with LLM" to save it as-is.

### Viewing Annotations

Click the PDF Converser extension icon and select **Open Notes Panel** to open the side panel. Annotations can be viewed in four modes:

- **By Page Order** — chronological, grouped by page number
- **By Type** — grouped by comment type (summary, critique, strength, etc.)
- **By Section** — LLM infers paper sections (Introduction, Methods, Results, etc.)
- **By Theme** — LLM groups by intellectual theme (methodology concerns, key findings, etc.)

### Exporting

Click **Export MD** in the side panel to download all annotations as a Markdown file.

### Comment Types

The LLM automatically classifies each annotation:

| Type | Color | Use case |
|------|-------|----------|
| Summary | Blue | Restating what the text says |
| Critique | Red | Identifying weaknesses or disagreements |
| Strength | Green | Noting something positive or well-done |
| Question | Orange | Expressing confusion or asking something |
| Related Work | Purple | Connecting to other papers or ideas |
| Suggestion | Teal | Proposing improvements or alternatives |
| Follow-up | Yellow | Things to investigate later |

## Architecture

```
extension/              Chrome Extension (Manifest V3)
  content/              Content script (selection, FAB, speech, submission)
  viewer/               PDF.js-based PDF viewer with selectable text layer
  sidebar/              Chrome Side Panel (notes display, organization)
  popup/                Settings (backend URL configuration)
  lib/                  Shared modules (API client, speech capture, PDF ID)

backend/                Python FastAPI
  app/
    routers/            API endpoints (notes CRUD, transcribe, organize, export)
    services/           Business logic (LLM cleanup, note storage, organization, export)
    prompts/            LangChain prompt templates
    config.py           Settings via Pydantic + .env
  notes/                JSON note files (one per PDF, named by content hash)
```

## Note Storage

Annotations are stored as JSON files in the `notes/` directory (configurable via `NOTES_DIR`). Each PDF gets one file, named by the SHA-256 hash of the first 64KB of the PDF's content:

```
notes/
  a1b2c3d4e5f6...json    # One file per PDF
```

This content-hash approach means:
- **Rename-proof**: Moving or renaming a PDF doesn't lose its notes — same content always produces the same hash
- **Human-readable**: Notes are plain JSON, easy to inspect or version-control
- **O(1) lookup**: No index or database needed — the hash maps directly to the filename
- Each file also stores the PDF title and URL as metadata for display purposes

## Future Ideas

These are not currently implemented but are tracked here for future development.

### Full-Document Context
Extract and store the full PDF text (page-by-page, via PDF.js `getTextContent()` in the viewer, sent to the backend). This unlocks a cluster of features that all depend on the LLM being able to see beyond the highlighted snippet:

- **Cross-referencing**: When you comment on a result, the LLM links it back to the method or measure that produced it. Comment on a claim in the Discussion and it finds the supporting data in Results. Comment near a figure reference and it pulls the surrounding description.
- **Context-aware annotation cleanup**: Currently the LLM only sees the highlighted text + your speech. With full-document context, it can resolve ambiguous references ("this result" becomes the specific finding), identify what section you're actually in, and classify comment types more accurately.
- **Accurate section detection**: The "By Section" organize view currently guesses sections from note snippets. With real section headers extracted from the full text, section mapping becomes exact.
- **PDF Q&A**: Ask questions about the entire paper (e.g., "Does this paper address limitation X later on?", "What was the sample size?", "How do they define this term?"). Could use direct LLM context for shorter papers or a retrieval-augmented approach for longer ones.
- **Citation-aware related work**: When you make a "related work" annotation mentioning another paper, the system checks the references section and surfaces the full citation.
- **Auto-generated paper summary**: Produce a structured summary of the paper to provide context alongside your annotations in exports.

**Implementation sketch**: The viewer already has access to all page text content via PDF.js. On PDF load, extract all text page-by-page and send it to a backend endpoint that stores it alongside the note file (or within it). The cleanup prompt and organize prompts can then include relevant document context. For longer papers, a chunking/retrieval strategy (e.g., embedding-based search over page chunks) would keep token usage manageable.

### Inline Highlights with Bidirectional Linking
Render persistent highlights on annotated text in the PDF viewer (color-coded by comment type). Link highlights and the note panel bidirectionally: clicking a highlight in the PDF scrolls the side panel to that annotation, and clicking an annotation in the side panel scrolls the PDF viewer to the highlighted passage. This would require storing the text range/position for each annotation and rendering highlight overlays on the text layer.

### Review-Oriented Export
Add export templates tailored to specific workflows:
- **Review export**: Generate a structured review following a standard format (Summary, Strengths, Weaknesses with subsections). Use provided `review-examples/` as style/tone references so the generated review matches the user's writing voice.
- **Notes export**: Organize annotations by topic/theme for personal reference. This partially exists in the current "By Theme" view and Markdown export, but a dedicated notes-oriented template could improve the output structure.
