from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class NoteCreate(BaseModel):
    pdf_identifier: str
    pdf_title: str | None = None
    selected_text: str
    page_number: int = 0
    raw_transcript: str
    skip_cleanup: bool = False


class NoteResponse(BaseModel):
    id: str
    pdf_identifier: str
    pdf_title: str | None
    selected_text: str
    page_number: int
    raw_transcript: str
    cleaned_comment: str
    comment_type: str
    created_at: datetime

    model_config = {"from_attributes": True}


class NoteListResponse(BaseModel):
    notes: list[NoteResponse]
    total: int


class NoteGroupResponse(BaseModel):
    title: str
    notes: list[NoteResponse]


class OrganizedNotesResponse(BaseModel):
    groups: list[NoteGroupResponse]
