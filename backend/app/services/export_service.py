from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Note


async def export_to_markdown(pdf_identifier: str, db: AsyncSession) -> str:
    stmt = (
        select(Note)
        .where(Note.pdf_identifier == pdf_identifier)
        .order_by(Note.page_number, Note.created_at)
    )
    result = await db.execute(stmt)
    notes = result.scalars().all()

    if not notes:
        return "# Annotations\n\nNo annotations found for this document.\n"

    pdf_title = notes[0].pdf_title or "Untitled Document"
    lines = [
        f"# Annotations: {pdf_title}",
        "",
        f"*Source: {pdf_identifier}*",
        "",
        f"*Exported from PDF Converser*",
        "",
        "---",
        "",
    ]

    current_page = None
    for note in notes:
        if note.page_number != current_page:
            current_page = note.page_number
            page_label = f"Page {current_page}" if current_page > 0 else "Page (unknown)"
            lines.append(f"## {page_label}")
            lines.append("")

        type_label = note.comment_type.replace("_", " ").title()
        lines.append(f"**[{type_label}]**")
        lines.append("")
        lines.append(f"> {note.selected_text}")
        lines.append("")
        lines.append(note.cleaned_comment)
        lines.append("")
        lines.append("<details><summary>Raw voice note</summary>")
        lines.append("")
        lines.append(note.raw_transcript)
        lines.append("")
        lines.append("</details>")
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)
