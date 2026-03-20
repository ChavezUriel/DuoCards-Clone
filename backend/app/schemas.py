from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class DeckSummary(BaseModel):
    id: int
    slug: str
    title: str
    description: str
    total_cards: int
    reviewed_cards: int
    known_cards: int
    unknown_cards: int
    completion_ratio: float
    is_completed: bool


class ReviewCard(BaseModel):
    card_id: int
    deck_id: int
    prompt_es: str
    answer_en: str
    part_of_speech: str | None = None
    definition_en: str | None = None
    main_translations_es: list[str] = Field(default_factory=list)
    collocations: list[str] = Field(default_factory=list)
    example_sentence: str | None = None
    example_es: str | None = None
    example_en: str | None = None


class ReviewSubmission(BaseModel):
    card_id: int = Field(gt=0)
    result: Literal["known", "unknown"]


class ReviewResult(BaseModel):
    card_id: int
    result: Literal["known", "unknown"]
    reviewed_at: datetime
    known_count: int
    unknown_count: int


class HealthResponse(BaseModel):
    status: str


class DeckProgress(BaseModel):
    deck_id: int
    total_cards: int
    reviewed_cards: int
    known_cards: int
    unknown_cards: int
    completion_ratio: float
    is_completed: bool
