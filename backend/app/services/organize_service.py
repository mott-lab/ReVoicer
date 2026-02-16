import json
import re

from app.prompts.organize import ORGANIZE_BY_SECTION_PROMPT, ORGANIZE_BY_THEME_PROMPT
from app.services.llm_service import get_llm
from app.services.note_store import get_note_store


async def organize_notes(
    pdf_identifier: str,
    mode: str,  # "section" or "theme"
) -> dict:
    store = get_note_store()
    notes = await store.list_notes(pdf_identifier)

    if not notes:
        return {"groups": []}

    # Prepare notes data for the LLM (truncate for token efficiency)
    notes_data = [
        {
            "id": n["id"],
            "page_number": n.get("page_number", 0),
            "selected_text": n["selected_text"][:200],
            "cleaned_comment": n["cleaned_comment"],
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
            return {"groups": [{"title": "All Notes", "notes": notes}]}

    # Build response with full note data
    notes_by_id = {n["id"]: n for n in notes}
    groups = []
    for group in organization.get("groups", []):
        group_notes = [
            notes_by_id[nid]
            for nid in group.get("note_ids", [])
            if nid in notes_by_id
        ]
        if group_notes:
            groups.append({
                "title": group["title"],
                "notes": group_notes,
            })

    return {"groups": groups}
