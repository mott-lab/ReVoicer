from fastapi import APIRouter, HTTPException, Query

from app.schemas import NoteCreate, NoteListResponse, NoteResponse
from app.services.cleanup_service import cleanup_transcript
from app.services.note_store import get_note_store

router = APIRouter()


@router.post("/", response_model=NoteResponse, status_code=201)
async def create_note(note_in: NoteCreate):
    cleaned, comment_type = await cleanup_transcript(
        note_in.selected_text, note_in.raw_transcript
    )

    store = get_note_store()
    note = await store.create_note(
        content_hash=note_in.pdf_identifier,
        pdf_title=note_in.pdf_title,
        pdf_url=None,
        selected_text=note_in.selected_text,
        page_number=note_in.page_number,
        raw_transcript=note_in.raw_transcript,
        cleaned_comment=cleaned,
        comment_type=comment_type,
    )
    return note


@router.get("/", response_model=NoteListResponse)
async def list_notes(pdf_identifier: str = Query(...)):
    store = get_note_store()
    notes = await store.list_notes(pdf_identifier)
    return NoteListResponse(notes=notes, total=len(notes))


@router.get("/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str, pdf_identifier: str = Query(...)):
    store = get_note_store()
    note = await store.get_note(pdf_identifier, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


@router.delete("/{note_id}", status_code=204)
async def delete_note(note_id: str, pdf_identifier: str = Query(...)):
    store = get_note_store()
    deleted = await store.delete_note(pdf_identifier, note_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Note not found")


@router.put("/{note_id}/reclean", response_model=NoteResponse)
async def reclean_note(note_id: str, pdf_identifier: str = Query(...)):
    """Re-run LLM cleanup on an existing note."""
    store = get_note_store()
    note = await store.get_note(pdf_identifier, note_id)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    cleaned, comment_type = await cleanup_transcript(
        note["selected_text"], note["raw_transcript"]
    )
    updated = await store.update_note(
        pdf_identifier, note_id,
        {"cleaned_comment": cleaned, "comment_type": comment_type},
    )
    return updated
