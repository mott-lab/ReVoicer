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
    highlight_data: dict | None = None


class NoteResponse(BaseModel):
    id: str
    pdf_identifier: str
    pdf_title: str | None
    selected_text: str
    page_number: int
    raw_transcript: str
    cleaned_comment: str
    comment_type: str
    highlight_data: dict | None = None
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


class DocumentTextUpload(BaseModel):
    pdf_identifier: str
    pages: dict[str, str]


class QARequest(BaseModel):
    pdf_identifier: str
    question: str
    selected_text: str | None = None
    page_number: int = 0


class QAResponse(BaseModel):
    id: str
    question: str
    answer: str
    selected_text: str | None = None
    page_number: int
    created_at: datetime


class QAListResponse(BaseModel):
    entries: list[QAResponse]
    total: int
