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
DATABASE_URL=sqlite+aiosqlite:///./pdf_converser.db

# Optional: use Ollama instead
# LLM_PROVIDER=ollama
# OLLAMA_BASE_URL=http://localhost:11434
# OLLAMA_MODEL=llama3.2
```

## Usage

### Recording Annotations

1. Open any PDF in Chrome (local files or web URLs)
2. Highlight a passage of text
3. Click the blue microphone button that appears
4. Speak your annotation — you'll see a live preview of your words
5. Click **Done** when finished
6. The annotation is transcribed via Whisper, cleaned by the LLM, and saved

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
    services/           Business logic (LLM cleanup, organization, export)
    prompts/            LangChain prompt templates
    models.py           SQLAlchemy ORM (Note model)
    config.py           Settings via Pydantic + .env
```

## Future Ideas

These are not currently implemented but are tracked here for future development.

### File-Based Note Persistence
Save annotations to JSON files instead of (or in addition to) the SQLite database. Proposed design:

- **Content-hash naming**: Store note files as `notes/{sha256_of_pdf_content}.json`, where the hash is computed from the first ~64KB of the PDF's bytes. This survives renames and moves — the content doesn't change, so the hash stays the same. Reading 64KB on file open is negligible. O(1) lookup, no separate index needed.
- **PDF reference as metadata**: Each note file also stores the last-known PDF filename/path as a field for display purposes and as a fallback if the content-hash approach ever needs debugging.
- **Edge cases**: The only case this breaks is if the PDF content itself changes (re-download, different version), which is rare for academic papers and arguably represents a different document anyway.
- **Path strategy**: TBD whether the stored PDF path in metadata should be relative to the project directory or absolute. Relative paths are more portable; absolute paths are unambiguous.

### Per-PDF Note Panel Scoping
Currently, if multiple PDFs are open, the side panel doesn't always distinguish between them. The panel should detect which PDF tab is active and load only the annotations for that specific document, switching automatically when the user changes tabs.

### Typed Annotations and PDF Q&A
Add more interaction modes beyond voice:
- **Text input**: Let the user type an annotation directly. Offer the choice to save it as-is or run it through the LLM for cleanup.
- **PDF Q&A**: Allow the user to ask a question about the entire PDF (e.g., "Does this paper address point XYZ later on?"). This would require sending the full PDF text to the LLM context, or using a retrieval-augmented approach over the document.

### Inline Highlights with Bidirectional Linking
Render persistent highlights on annotated text in the PDF viewer (color-coded by comment type). Link highlights and the note panel bidirectionally: clicking a highlight in the PDF scrolls the side panel to that annotation, and clicking an annotation in the side panel scrolls the PDF viewer to the highlighted passage. This would require storing the text range/position for each annotation and rendering highlight overlays on the text layer.

### Review-Oriented Export
Add export templates tailored to specific workflows:
- **Review export**: Generate a structured review following a standard format (Summary, Strengths, Weaknesses with subsections). Use provided `review-examples/` as style/tone references so the generated review matches the user's writing voice.
- **Notes export**: Organize annotations by topic/theme for personal reference. This partially exists in the current "By Theme" view and Markdown export, but a dedicated notes-oriented template could improve the output structure.
