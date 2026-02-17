from langchain_core.prompts import ChatPromptTemplate

QA_PROMPT = ChatPromptTemplate.from_messages([
    ("system", (
        "You are an expert at reading and analyzing academic papers. "
        "Answer the user's question based solely on the document text provided below. "
        "Be specific and cite relevant page numbers when possible. "
        "If the information is not in the document, say so clearly. "
        "Keep answers concise but thorough.\n\n"
        "=== DOCUMENT TEXT ===\n{document_text}\n=== END DOCUMENT ==="
    )),
    ("human", "{question_with_context}"),
])
