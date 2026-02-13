from langchain_core.language_models.chat_models import BaseChatModel
from langchain_openai import ChatOpenAI

from app.config import get_settings


def get_llm() -> BaseChatModel:
    """Factory that returns the configured LLM provider.

    To add a new provider:
    1. pip install langchain-<provider>
    2. Add an elif branch here
    3. Add config fields to Settings
    """
    settings = get_settings()

    if settings.llm_provider == "openai":
        return ChatOpenAI(
            model=settings.openai_model,
            api_key=settings.openai_api_key,
            temperature=0.3,
        )
    elif settings.llm_provider == "ollama":
        from langchain_ollama import ChatOllama

        return ChatOllama(
            model=settings.ollama_model,
            base_url=settings.ollama_base_url,
        )
    else:
        raise ValueError(f"Unknown LLM provider: {settings.llm_provider}")
