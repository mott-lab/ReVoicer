from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.organize_service import organize_notes

router = APIRouter()


@router.get("/by-section")
async def organize_by_section(
    pdf_identifier: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    return await organize_notes(pdf_identifier, "section", db)


@router.get("/by-theme")
async def organize_by_theme(
    pdf_identifier: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    return await organize_notes(pdf_identifier, "theme", db)
