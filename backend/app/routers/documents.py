from fastapi import APIRouter

from app.schemas import DocumentTextUpload
from app.services.document_store import get_document_store

router = APIRouter()


@router.post("/text")
async def upload_document_text(body: DocumentTextUpload):
    store = get_document_store()
    await store.save_document_text(body.pdf_identifier, body.pages)
    return {"status": "ok"}
