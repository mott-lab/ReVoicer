import json
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Note
from app.prompts.organize import ORGANIZE_BY_SECTION_PROMPT, ORGANIZE_BY_THEME_PROMPT
from app.schemas import NoteResponse
from app.services.llm_service import get_llm


async def organize_notes(
    pdf_identifier: str,
    mode: str,  # "section" or "theme"
    db: AsyncSession,
) -> dict:
    stmt = (
        select(Note)
        .where(Note.pdf_identifier == pdf_identifier)
        .order_by(Note.page_number, Note.created_at)
    )
    result = await db.execute(stmt)
    notes = result.scalars().all()

    if not notes:
        return {"groups": []}

    # Prepare notes data for the LLM (truncate for token efficiency)
    notes_data = [
        {
            "id": n.id,
            "page_number": n.page_number,
            "selected_text": n.selected_text[:200],
            "cleaned_comment": n.cleaned_comment,
        }
        for n in notes
    ]
    notes_json = json.dumps(notes_data, indent=2)

    prompt = ORGANIZE_BY_SECTION_PROMPT if mode == "section" else ORGANIZE_BY_THEME_PROMPT
    llm = get_llm()
    chain = prompt | llm
    response = await chain.ainvoke({"notes_json": notes_json})

    # Parse LLM JSON response
    try:
        organization = json.loads(response.content)
    except json.JSONDecodeError:
        # Try to extract JSON from the response
        match = re.search(r"\{.*\}", response.content, re.DOTALL)
        if match:
            organization = json.loads(match.group())
        else:
            # Fallback: put all notes in one group
            return {
                "groups": [
                    {
                        "title": "All Notes",
                        "notes": [
                            NoteResponse.model_validate(n).model_dump()
                            for n in notes
                        ],
                    }
                ]
            }

    # Build response with full note data
    notes_by_id = {n.id: n for n in notes}
    groups = []
    for group in organization.get("groups", []):
        group_notes = [
            NoteResponse.model_validate(notes_by_id[nid]).model_dump()
            for nid in group.get("note_ids", [])
            if nid in notes_by_id
        ]
        if group_notes:
            groups.append({
                "title": group["title"],
                "notes": group_notes,
            })

    return {"groups": groups}
