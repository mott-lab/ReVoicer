"""File-based document text storage.

Stores the full extracted text of each PDF in a separate JSON file:
notes/{content_hash}.text.json

This is kept separate from the notes file so that note CRUD operations
don't need to read/write potentially large document text.
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from app.config import get_settings


class DocumentStore:
    def __init__(self, notes_dir: Path | None = None):
        self.notes_dir = notes_dir or Path(get_settings().notes_dir)
        self.notes_dir.mkdir(parents=True, exist_ok=True)

    def _file_path(self, content_hash: str) -> Path:
        return self.notes_dir / f"{content_hash}.text.json"

    async def save_document_text(
        self, content_hash: str, pages: dict[str, str]
    ) -> None:
        path = self._file_path(content_hash)
        data = {"content_hash": content_hash, "pages": pages}
        text = json.dumps(data, ensure_ascii=False)
        loop = asyncio.get_event_loop()

        def _atomic_write():
            fd, tmp_path = tempfile.mkstemp(
                dir=str(self.notes_dir), suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(text)
                os.replace(tmp_path, str(path))
            except BaseException:
                os.unlink(tmp_path)
                raise

        await loop.run_in_executor(None, _atomic_write)

    async def load_document_text(
        self, content_hash: str
    ) -> dict[str, str] | None:
        path = self._file_path(content_hash)
        if not path.exists():
            return None
        loop = asyncio.get_event_loop()
        raw = await loop.run_in_executor(None, path.read_text, "utf-8")
        data = json.loads(raw)
        return data.get("pages")

    def format_for_llm(self, pages: dict[str, str]) -> str:
        """Format page texts into a single string for LLM context."""
        parts = []
        for page_num in sorted(pages.keys(), key=lambda k: int(k)):
            text = pages[page_num].strip()
            if text:
                parts.append(f"[Page {page_num}]\n{text}")
        return "\n\n".join(parts)


_store: DocumentStore | None = None


def get_document_store() -> DocumentStore:
    global _store
    if _store is None:
        _store = DocumentStore()
    return _store
