import json
import re

from app.prompts.cleanup import CLASSIFY_PROMPT, CLEANUP_PROMPT
from app.services.llm_service import get_llm

VALID_TYPES = {
    "summary", "critique", "strength", "question",
    "related_work", "suggestion", "follow_up",
}


async def cleanup_transcript(
    selected_text: str, raw_transcript: str
) -> tuple[str, str]:
    """Returns (cleaned_comment, comment_type)."""
    llm = get_llm()
    chain = CLEANUP_PROMPT | llm
    result = await chain.ainvoke({
        "selected_text": selected_text,
        "raw_transcript": raw_transcript,
    })

    # Parse JSON response from LLM
    content = result.content.strip()
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        # Try to extract JSON from the response
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
        else:
            # Fallback: treat the whole response as the comment
            return content, "summary"

    comment = parsed.get("comment", content)
    comment_type = parsed.get("type", "summary")

    # Validate the type
    if comment_type not in VALID_TYPES:
        comment_type = "summary"

    return comment, comment_type


async def classify_comment_type(selected_text: str, comment: str) -> str:
    """Classify a typed annotation without rewriting it. Returns comment_type."""
    llm = get_llm()
    chain = CLASSIFY_PROMPT | llm
    result = await chain.ainvoke({
        "selected_text": selected_text,
        "comment": comment,
    })

    content = result.content.strip()
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            parsed = json.loads(match.group())
        else:
            return "summary"

    comment_type = parsed.get("type", "summary")
    if comment_type not in VALID_TYPES:
        comment_type = "summary"

    return comment_type
