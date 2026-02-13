from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    pdf_identifier: Mapped[str] = mapped_column(String(1024), index=True)
    pdf_title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    selected_text: Mapped[str] = mapped_column(Text)
    page_number: Mapped[int] = mapped_column(Integer, default=0)
    raw_transcript: Mapped[str] = mapped_column(Text)
    cleaned_comment: Mapped[str] = mapped_column(Text, default="")
    comment_type: Mapped[str] = mapped_column(String(32), default="summary")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
