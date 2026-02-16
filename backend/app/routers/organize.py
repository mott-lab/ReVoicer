from fastapi import APIRouter, Query

from app.services.organize_service import organize_notes

router = APIRouter()


@router.get("/by-section")
async def organize_by_section(pdf_identifier: str = Query(...)):
    return await organize_notes(pdf_identifier, "section")


@router.get("/by-theme")
async def organize_by_theme(pdf_identifier: str = Query(...)):
    return await organize_notes(pdf_identifier, "theme")
