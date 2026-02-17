"""File-based JSON note storage.

Each PDF's notes are stored in a single JSON file named by the PDF's
content hash: notes/{content_hash}.json

File format:
{
    "content_hash": "abc123...",
    "pdf_title": "Some Paper",
    "pdf_url": "https://...",
    "notes": [ ... ]
}
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import get_settings


class NoteStore:
    def __init__(self, notes_dir: Path | None = None):
        self.notes_dir = notes_dir or Path(get_settings().notes_dir)
        self.notes_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, content_hash: str) -> asyncio.Lock:
        if content_hash not in self._locks:
            self._locks[content_hash] = asyncio.Lock()
        return self._locks[content_hash]

    def _file_path(self, content_hash: str) -> Path:
        return self.notes_dir / f"{content_hash}.json"

    async def _read_file(self, content_hash: str) -> dict[str, Any]:
        path = self._file_path(content_hash)
        if not path.exists():
            return {
                "content_hash": content_hash,
                "pdf_title": None,
                "pdf_url": None,
                "notes": [],
            }
        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(None, path.read_text, "utf-8")
        return json.loads(text)

    async def _write_file(self, content_hash: str, data: dict[str, Any]) -> None:
        path = self._file_path(content_hash)
        text = json.dumps(data, indent=2, default=str)
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

    async def create_note(
        self,
        content_hash: str,
        pdf_title: str | None,
        pdf_url: str | None,
        selected_text: str,
        page_number: int,
        raw_transcript: str,
        cleaned_comment: str,
        comment_type: str,
        highlight_data: dict | None = None,
    ) -> dict[str, Any]:
        note = {
            "id": str(uuid.uuid4()),
            "selected_text": selected_text,
            "page_number": page_number,
            "raw_transcript": raw_transcript,
            "cleaned_comment": cleaned_comment,
            "comment_type": comment_type,
            "highlight_data": highlight_data,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        async with self._get_lock(content_hash):
            data = await self._read_file(content_hash)
            if pdf_title:
                data["pdf_title"] = pdf_title
            if pdf_url:
                data["pdf_url"] = pdf_url
            data["notes"].append(note)
            await self._write_file(content_hash, data)

        return {
            **note,
            "pdf_identifier": content_hash,
            "pdf_title": data.get("pdf_title"),
        }

    async def list_notes(self, content_hash: str) -> list[dict[str, Any]]:
        data = await self._read_file(content_hash)
        notes = data["notes"]
        notes.sort(key=lambda n: (n.get("page_number", 0), n.get("created_at", "")))
        for n in notes:
            n["pdf_identifier"] = content_hash
            n["pdf_title"] = data.get("pdf_title")
        return notes

    async def get_note(self, content_hash: str, note_id: str) -> dict[str, Any] | None:
        data = await self._read_file(content_hash)
        for n in data["notes"]:
            if n["id"] == note_id:
                n["pdf_identifier"] = content_hash
                n["pdf_title"] = data.get("pdf_title")
                return n
        return None

    async def delete_note(self, content_hash: str, note_id: str) -> bool:
        async with self._get_lock(content_hash):
            data = await self._read_file(content_hash)
            original_len = len(data["notes"])
            data["notes"] = [n for n in data["notes"] if n["id"] != note_id]
            if len(data["notes"]) == original_len:
                return False
            await self._write_file(content_hash, data)
        return True

    async def update_note(
        self, content_hash: str, note_id: str, updates: dict[str, Any]
    ) -> dict[str, Any] | None:
        async with self._get_lock(content_hash):
            data = await self._read_file(content_hash)
            for n in data["notes"]:
                if n["id"] == note_id:
                    n.update(updates)
                    await self._write_file(content_hash, data)
                    n["pdf_identifier"] = content_hash
                    n["pdf_title"] = data.get("pdf_title")
                    return n
        return None


_store: NoteStore | None = None


def get_note_store() -> NoteStore:
    global _store
    if _store is None:
        _store = NoteStore()
    return _store
