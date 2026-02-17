"""File-based JSON Q&A storage.

Each PDF's Q&A history is stored in a separate JSON file named by the PDF's
content hash: notes/{content_hash}.qa.json

File format:
{
    "content_hash": "abc123...",
    "entries": [ ... ]
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


class QAStore:
    def __init__(self, notes_dir: Path | None = None):
        self.notes_dir = notes_dir or Path(get_settings().notes_dir)
        self.notes_dir.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, content_hash: str) -> asyncio.Lock:
        if content_hash not in self._locks:
            self._locks[content_hash] = asyncio.Lock()
        return self._locks[content_hash]

    def _file_path(self, content_hash: str) -> Path:
        return self.notes_dir / f"{content_hash}.qa.json"

    async def _read_file(self, content_hash: str) -> dict[str, Any]:
        path = self._file_path(content_hash)
        if not path.exists():
            return {
                "content_hash": content_hash,
                "entries": [],
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

    async def create_entry(
        self,
        content_hash: str,
        question: str,
        answer: str,
        selected_text: str | None,
        page_number: int,
    ) -> dict[str, Any]:
        entry = {
            "id": str(uuid.uuid4()),
            "question": question,
            "answer": answer,
            "selected_text": selected_text,
            "page_number": page_number,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        async with self._get_lock(content_hash):
            data = await self._read_file(content_hash)
            data["entries"].append(entry)
            await self._write_file(content_hash, data)

        return entry

    async def list_entries(self, content_hash: str) -> list[dict[str, Any]]:
        data = await self._read_file(content_hash)
        entries = data["entries"]
        entries.sort(key=lambda e: e.get("created_at", ""))
        return entries

    async def delete_entry(self, content_hash: str, entry_id: str) -> bool:
        async with self._get_lock(content_hash):
            data = await self._read_file(content_hash)
            original_len = len(data["entries"])
            data["entries"] = [e for e in data["entries"] if e["id"] != entry_id]
            if len(data["entries"]) == original_len:
                return False
            await self._write_file(content_hash, data)
        return True


_store: QAStore | None = None


def get_qa_store() -> QAStore:
    global _store
    if _store is None:
        _store = QAStore()
    return _store
