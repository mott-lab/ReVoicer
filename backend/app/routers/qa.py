from fastapi import APIRouter, HTTPException

from app.prompts.qa import QA_PROMPT
from app.schemas import QARequest, QAResponse
from app.services.document_store import get_document_store
from app.services.llm_service import get_llm

router = APIRouter()


@router.post("/", response_model=QAResponse)
async def ask_question(body: QARequest):
    store = get_document_store()
    pages = await store.load_document_text(body.pdf_identifier)
    if not pages:
        raise HTTPException(
            status_code=404,
            detail="Document text not available. Please open the PDF first.",
        )

    document_text = store.format_for_llm(pages)

    # Build the human message with optional selected-text context
    parts = []
    if body.selected_text:
        parts.append(
            f"I have highlighted the following passage for context:\n"
            f"---\n{body.selected_text}\n---\n"
        )
    parts.append(body.question)
    question_with_context = "\n".join(parts)

    llm = get_llm()
    chain = QA_PROMPT | llm
    result = await chain.ainvoke({
        "document_text": document_text,
        "question_with_context": question_with_context,
    })

    return QAResponse(answer=result.content)
