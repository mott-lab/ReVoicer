from langchain_core.prompts import ChatPromptTemplate

ORGANIZE_BY_SECTION_PROMPT = ChatPromptTemplate.from_messages([
    ("system", (
        "You are organizing annotations from an academic paper.\n"
        "Given a list of annotations with their page numbers and highlighted text, "
        "group them by logical sections of the paper (e.g., Abstract, Introduction, "
        "Related Work, Methods, Results, Discussion, Conclusion).\n\n"
        "Infer section names from the highlighted text context and page numbers.\n"
        "If you cannot determine the section, use \"Uncategorized\".\n\n"
        "Return a JSON object with this exact structure:\n"
        '{{"groups": [{{"title": "Section Name", "note_ids": ["id1", "id2", "id3"]}}]}}\n\n'
        "Only output valid JSON. No other text."
    )),
    ("human", "Here are the annotations:\n\n{notes_json}"),
])

ORGANIZE_BY_THEME_PROMPT = ChatPromptTemplate.from_messages([
    ("system", (
        "You are organizing annotations from an academic paper.\n"
        "Given a list of annotations with their highlighted text and cleaned comments, "
        "group them by intellectual theme or topic. Examples of themes:\n"
        "- Methodology concerns\n"
        "- Key findings\n"
        "- Connections to other work\n"
        "- Questions for follow-up\n"
        "- Statistical issues\n"
        "- Writing/presentation\n"
        "- Motivation/framing\n\n"
        "Create 2-6 thematic groups based on the actual content of the annotations.\n\n"
        "Return a JSON object with this exact structure:\n"
        '{{"groups": [{{"title": "Theme Name", "note_ids": ["id1", "id2", "id3"]}}]}}\n\n'
        "Only output valid JSON. No other text."
    )),
    ("human", "Here are the annotations:\n\n{notes_json}"),
])
