from app.services.note_store import get_note_store


async def export_to_markdown(pdf_identifier: str) -> str:
    store = get_note_store()
    notes = await store.list_notes(pdf_identifier)

    if not notes:
        return "# Annotations\n\nNo annotations found for this document.\n"

    pdf_title = notes[0].get("pdf_title") or "Untitled Document"
    lines = [
        f"# Annotations: {pdf_title}",
        "",
        f"*Source: {pdf_identifier}*",
        "",
        "*Exported from PDF Converser*",
        "",
        "---",
        "",
    ]

    current_page = None
    for note in notes:
        if note.get("page_number", 0) != current_page:
            current_page = note.get("page_number", 0)
            page_label = f"Page {current_page}" if current_page > 0 else "Page (unknown)"
            lines.append(f"## {page_label}")
            lines.append("")

        type_label = note.get("comment_type", "summary").replace("_", " ").title()
        lines.append(f"**[{type_label}]**")
        lines.append("")
        lines.append(f"> {note['selected_text']}")
        lines.append("")
        lines.append(note["cleaned_comment"])
        lines.append("")
        lines.append("<details><summary>Raw voice note</summary>")
        lines.append("")
        lines.append(note["raw_transcript"])
        lines.append("")
        lines.append("</details>")
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)
