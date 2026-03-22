from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


GenerationPhase = Literal["draft", "refined"]


def _normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Expected a string")
    normalized = value.strip()
    if not normalized:
        raise ValueError("Value cannot be empty")
    return normalized


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    return _normalize_text(value)


def _normalize_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Expected a list of strings")

    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = _normalize_text(item)
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        normalized.append(text)
    return normalized


class DeckSectionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    communicative_goal: str
    lexical_focus: list[str] = Field(default_factory=list)
    target_card_count: int = Field(ge=1, le=40)

    _normalize_name = field_validator("name", mode="before")(_normalize_text)
    _normalize_goal = field_validator("communicative_goal", mode="before")(_normalize_text)
    _normalize_focus = field_validator("lexical_focus", mode="before")(_normalize_text_list)


class DeckGenerationSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str
    title: str
    description: str
    topic: str
    difficulty: Literal["beginner", "elementary", "intermediate", "upper-intermediate", "advanced"] = "beginner"
    desired_card_count: int = Field(ge=4, le=120)
    batch_size: int = Field(default=10, ge=4, le=20)
    model: str = "qwen3.5:latest"
    fallback_models: list[str] = Field(default_factory=lambda: ["gemma3:4b", "llama3.1:latest"])
    overwrite_mode: Literal["fail", "append", "replace"] = "fail"
    language_from: Literal["es"] = "es"
    language_to: Literal["en"] = "en"
    learner_profile: str | None = None
    generation_notes: str | None = None
    vocabulary_focus: list[str] = Field(default_factory=list)
    excluded_vocabulary: list[str] = Field(default_factory=list)
    sections: list[DeckSectionSpec] = Field(default_factory=list)

    _normalize_slug = field_validator("slug", mode="before")(_normalize_text)
    _normalize_title = field_validator("title", mode="before")(_normalize_text)
    _normalize_description = field_validator("description", mode="before")(_normalize_text)
    _normalize_topic = field_validator("topic", mode="before")(_normalize_text)
    _normalize_learner = field_validator("learner_profile", mode="before")(_normalize_optional_text)
    _normalize_notes = field_validator("generation_notes", mode="before")(_normalize_optional_text)
    _normalize_fallback_models = field_validator("fallback_models", mode="before")(_normalize_text_list)
    _normalize_focus = field_validator("vocabulary_focus", mode="before")(_normalize_text_list)
    _normalize_excluded = field_validator("excluded_vocabulary", mode="before")(_normalize_text_list)

    @model_validator(mode="after")
    def validate_sections(self) -> "DeckGenerationSpec":
        if self.sections:
            section_total = sum(section.target_card_count for section in self.sections)
            if section_total != self.desired_card_count:
                raise ValueError("desired_card_count must match the total target_card_count across sections")
        return self


class DeckBlueprintSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    communicative_goal: str
    lexical_focus: list[str] = Field(default_factory=list)
    target_card_count: int = Field(ge=1, le=40)

    _normalize_name = field_validator("name", mode="before")(_normalize_text)
    _normalize_goal = field_validator("communicative_goal", mode="before")(_normalize_text)
    _normalize_focus = field_validator("lexical_focus", mode="before")(_normalize_text_list)


class DeckBlueprint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pedagogical_goal: str
    sections: list[DeckBlueprintSection]

    _normalize_goal = field_validator("pedagogical_goal", mode="before")(_normalize_text)

    @model_validator(mode="after")
    def ensure_sections(self) -> "DeckBlueprint":
        if not self.sections:
            raise ValueError("At least one section is required")
        return self


class GeneratedCard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    spanish: str
    english: str
    section_name: str | None = None
    part_of_speech: str | None = None
    definition_en: str | None = None
    main_translations_es: list[str] = Field(default_factory=list)
    collocations: list[str] = Field(default_factory=list)
    example_sentence: str | None = None
    example_es: str | None = None
    example_en: str | None = None

    _normalize_spanish = field_validator("spanish", mode="before")(_normalize_text)
    _normalize_english = field_validator("english", mode="before")(_normalize_text)
    _normalize_section = field_validator("section_name", mode="before")(_normalize_optional_text)
    _normalize_pos = field_validator("part_of_speech", mode="before")(_normalize_optional_text)
    _normalize_definition = field_validator("definition_en", mode="before")(_normalize_optional_text)
    _normalize_translations = field_validator("main_translations_es", mode="before")(_normalize_text_list)
    _normalize_collocations = field_validator("collocations", mode="before")(_normalize_text_list)
    _normalize_sentence = field_validator("example_sentence", mode="before")(_normalize_optional_text)
    _normalize_example_es = field_validator("example_es", mode="before")(_normalize_optional_text)
    _normalize_example_en = field_validator("example_en", mode="before")(_normalize_optional_text)


class GeneratedCardBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cards: list[GeneratedCard] = Field(default_factory=list)


class RejectedCard(BaseModel):
    raw_card: dict[str, Any]
    issues: list[str] = Field(default_factory=list)


class DeckPreview(BaseModel):
    spec: DeckGenerationSpec
    blueprint: DeckBlueprint
    cards: list[GeneratedCard]
    warnings: list[str] = Field(default_factory=list)
    rejected_cards: list[RejectedCard] = Field(default_factory=list)


class SpecFileInfo(BaseModel):
    name: str
    path: str


class SpecFileRequest(BaseModel):
    spec_path: str = Field(min_length=1)
    slug: str | None = None


class SpecValidationResponse(BaseModel):
    specs: list[DeckGenerationSpec]
    selected_spec: DeckGenerationSpec | None = None


class GenerateDeckRequest(BaseModel):
    spec_path: str = Field(min_length=1)
    slug: str | None = None
    max_repair_attempts: int = Field(default=1, ge=0, le=3)


class EnrichDeckRequest(BaseModel):
    deck_id: int = Field(gt=0)
    max_repair_attempts: int = Field(default=1, ge=0, le=3)


class GenerationPhaseSummary(BaseModel):
    generation_phase: GenerationPhase
    draft_cards: int = Field(default=0, ge=0)
    refined_cards: int = Field(default=0, ge=0)
    total_cards: int = Field(default=0, ge=0)


class GenerateWordSetResponse(BaseModel):
    spec: DeckGenerationSpec
    blueprint: DeckBlueprint
    deck_id: int
    created_deck: bool
    inserted_cards: int
    updated_cards: int
    deleted_cards: int
    total_cards: int
    phase_summary: GenerationPhaseSummary
    warnings: list[str] = Field(default_factory=list)
    rejected_cards: list[RejectedCard] = Field(default_factory=list)


class EnrichDeckResponse(BaseModel):
    deck_id: int
    enriched_cards: int
    remaining_draft_cards: int
    phase_summary: GenerationPhaseSummary
    warnings: list[str] = Field(default_factory=list)
    rejected_cards: list[RejectedCard] = Field(default_factory=list)


class GenerateDeckResponse(BaseModel):
    spec: DeckGenerationSpec
    blueprint: DeckBlueprint
    deck_id: int
    created_deck: bool
    inserted_cards: int
    updated_cards: int
    deleted_cards: int
    total_cards: int
    phase_summary: GenerationPhaseSummary
    warnings: list[str] = Field(default_factory=list)
    rejected_cards: list[RejectedCard] = Field(default_factory=list)


class GenerateBatchResponse(BaseModel):
    results: list[GenerateDeckResponse] = Field(default_factory=list)