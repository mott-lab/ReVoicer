from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse

from app.services.export_service import export_to_markdown

router = APIRouter()


@router.get("/markdown", response_class=PlainTextResponse)
async def export_markdown(pdf_identifier: str = Query(...)):
    markdown = await export_to_markdown(pdf_identifier)
    return PlainTextResponse(
        content=markdown,
        headers={
            "Content-Disposition": "attachment; filename=annotations.md",
            "Content-Type": "text/markdown; charset=utf-8",
        },
    )
