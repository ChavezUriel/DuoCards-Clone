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
    deck_title: str | None = None
    section_name: str | None = None
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


class SmartPracticeSettings(BaseModel):
    new_block_size: int = Field(default=7, ge=5, le=12)
    review_batch_size: int = Field(default=30, ge=20, le=50)
    interleaving_intensity: Literal["low", "medium", "high"] = "medium"
    focus_mode: Literal["auto", "new_material", "review"] = "auto"


class SmartPracticeStartRequest(BaseModel):
    settings: SmartPracticeSettings = Field(default_factory=SmartPracticeSettings)


class SmartPracticeSessionSummary(BaseModel):
    session_id: int
    status: Literal["active", "completed", "abandoned"]
    mode: Literal["new_material", "review"]
    focus_mode: Literal["auto", "new_material", "review"]
    total_cards: int
    completed_cards: int
    remaining_cards: int
    new_block_size: int
    review_batch_size: int
    interleaving_intensity: Literal["low", "medium", "high"]


class SmartPracticeSession(BaseModel):
    summary: SmartPracticeSessionSummary
    current_card: ReviewCard | None = None


class SmartPracticeReviewSubmission(BaseModel):
    card_id: int = Field(gt=0)
    result: Literal["known", "unknown"]


class SmartPracticeReviewResult(BaseModel):
    session: SmartPracticeSession
