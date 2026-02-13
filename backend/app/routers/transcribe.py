from fastapi import APIRouter, HTTPException, UploadFile
from openai import AsyncOpenAI

from app.config import get_settings

router = APIRouter()


@router.post("/transcribe")
async def transcribe_audio(audio: UploadFile):
    settings = get_settings()

    if not settings.openai_api_key:
        raise HTTPException(
            status_code=503,
            detail="OpenAI API key not configured. Set OPENAI_API_KEY in .env",
        )

    client = AsyncOpenAI(api_key=settings.openai_api_key)
    audio_bytes = await audio.read()

    try:
        transcript = await client.audio.transcriptions.create(
            model="whisper-1",
            file=(audio.filename or "recording.webm", audio_bytes),
            response_format="text",
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Whisper API error: {e}")

    return {"text": transcript.strip()}
