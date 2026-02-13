from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import init_db
from app.routers import export, notes, organize, transcribe


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="PDF Converser API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(notes.router, prefix="/api/notes", tags=["notes"])
app.include_router(export.router, prefix="/api/export", tags=["export"])
app.include_router(organize.router, prefix="/api/organize", tags=["organize"])
app.include_router(transcribe.router, prefix="/api", tags=["transcribe"])


@app.get("/api/health")
async def health():
    return {"status": "ok"}
