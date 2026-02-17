from fastapi import APIRouter, HTTPException, Response

from app.prompts.qa import QA_PROMPT
from app.schemas import QAListResponse, QARequest, QAResponse
from app.services.document_store import get_document_store
from app.services.llm_service import get_llm
from app.services.qa_store import get_qa_store

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

    # Persist the Q&A pair
    qa_store = get_qa_store()
    entry = await qa_store.create_entry(
        content_hash=body.pdf_identifier,
        question=body.question,
        answer=result.content,
        selected_text=body.selected_text,
        page_number=body.page_number,
    )

    return QAResponse(
        id=entry["id"],
        question=entry["question"],
        answer=entry["answer"],
        selected_text=entry["selected_text"],
        page_number=entry["page_number"],
        created_at=entry["created_at"],
    )


@router.get("/", response_model=QAListResponse)
async def list_questions(pdf_identifier: str):
    qa_store = get_qa_store()
    entries = await qa_store.list_entries(pdf_identifier)
    return QAListResponse(
        entries=entries,
        total=len(entries),
    )


@router.delete("/{entry_id}", status_code=204)
async def delete_question(entry_id: str, pdf_identifier: str):
    qa_store = get_qa_store()
    deleted = await qa_store.delete_entry(pdf_identifier, entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Q&A entry not found")
    return Response(status_code=204)
