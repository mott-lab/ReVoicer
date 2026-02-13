from langchain_core.prompts import ChatPromptTemplate

CLEANUP_PROMPT = ChatPromptTemplate.from_messages([
    ("system", (
        "You are a research annotation assistant. Your job is to clean up "
        "a voice-recorded annotation about a passage in an academic paper, "
        "and classify its type.\n\n"
        "The user highlighted the following text from the paper:\n"
        "---\n{selected_text}\n---\n\n"
        "They then spoke their annotation aloud. The raw speech transcript may contain:\n"
        "- Filler words (um, uh, like, you know)\n"
        "- False starts and self-corrections\n"
        "- Rambling or repetitive phrasing\n"
        "- Incomplete sentences\n\n"
        "Your task:\n"
        "1. Rewrite their annotation as a clear, concise, well-structured comment "
        "that PRESERVES ALL of their intellectual content, insights, questions, and "
        "critiques. Do not add your own analysis. Do not remove any substantive points "
        "they made. Just clean up the delivery.\n\n"
        "2. Classify the comment as exactly ONE of these types:\n"
        "- summary: Restating or paraphrasing what the text says\n"
        "- critique: Identifying a weakness, flaw, or disagreement\n"
        "- strength: Noting something positive or well-done\n"
        "- question: Expressing confusion or asking something\n"
        "- related_work: Connecting to other papers, authors, or ideas\n"
        "- suggestion: Proposing an improvement or alternative approach\n"
        "- follow_up: Noting something to investigate later or apply elsewhere\n\n"
        "Output ONLY valid JSON with exactly two fields:\n"
        '{{"comment": "the cleaned annotation", "type": "one_of_the_types_above"}}\n\n'
        "No other text. Just the JSON."
    )),
    ("human", "{raw_transcript}"),
])
