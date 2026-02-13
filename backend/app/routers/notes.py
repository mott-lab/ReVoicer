from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Note
from app.schemas import NoteCreate, NoteListResponse, NoteResponse
from app.services.cleanup_service import cleanup_transcript

router = APIRouter()


@router.post("/", response_model=NoteResponse, status_code=201)
async def create_note(note_in: NoteCreate, db: AsyncSession = Depends(get_db)):
    cleaned, comment_type = await cleanup_transcript(
        note_in.selected_text, note_in.raw_transcript
    )

    note = Note(
        pdf_identifier=note_in.pdf_identifier,
        pdf_title=note_in.pdf_title,
        selected_text=note_in.selected_text,
        page_number=note_in.page_number,
        raw_transcript=note_in.raw_transcript,
        cleaned_comment=cleaned,
        comment_type=comment_type,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


@router.get("/", response_model=NoteListResponse)
async def list_notes(
    pdf_identifier: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(Note)
        .where(Note.pdf_identifier == pdf_identifier)
        .order_by(Note.page_number, Note.created_at)
    )
    result = await db.execute(stmt)
    notes = result.scalars().all()
    return NoteListResponse(notes=notes, total=len(notes))


@router.get("/{note_id}", response_model=NoteResponse)
async def get_note(note_id: int, db: AsyncSession = Depends(get_db)):
    note = await db.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


@router.delete("/{note_id}", status_code=204)
async def delete_note(note_id: int, db: AsyncSession = Depends(get_db)):
    note = await db.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    await db.delete(note)
    await db.commit()


@router.put("/{note_id}/reclean", response_model=NoteResponse)
async def reclean_note(note_id: int, db: AsyncSession = Depends(get_db)):
    """Re-run LLM cleanup on an existing note."""
    note = await db.get(Note, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    note.cleaned_comment, note.comment_type = await cleanup_transcript(
        note.selected_text, note.raw_transcript
    )
    await db.commit()
    await db.refresh(note)
    return note
