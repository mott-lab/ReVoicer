from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.export_service import export_to_markdown

router = APIRouter()


@router.get("/markdown", response_class=PlainTextResponse)
async def export_markdown(
    pdf_identifier: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    markdown = await export_to_markdown(pdf_identifier, db)
    return PlainTextResponse(
        content=markdown,
        headers={
            "Content-Disposition": "attachment; filename=annotations.md",
            "Content-Type": "text/markdown; charset=utf-8",
        },
    )
