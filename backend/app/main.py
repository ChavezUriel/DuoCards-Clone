from __future__ import annotations

from datetime import datetime, timezone
import json

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .db import get_connection, initialize_database
from .schemas import DeckProgress, DeckSummary, HealthResponse, ReviewCard, ReviewResult, ReviewSubmission

app = FastAPI(title="DuoCards Clone API", version="0.1.0")

ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event() -> None:
    initialize_database()


@app.get("/api/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    return HealthResponse(status="ok")


@app.get("/api/decks", response_model=list[DeckSummary])
def list_decks() -> list[DeckSummary]:
    query = """
        SELECT
            d.id,
            d.slug,
            d.title,
            d.description,
            COUNT(c.id) AS total_cards,
            COALESCE(SUM(CASE WHEN cp.last_result IS NOT NULL THEN 1 ELSE 0 END), 0) AS reviewed_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'known' THEN 1 ELSE 0 END), 0) AS known_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cards
        FROM decks d
        LEFT JOIN cards c ON c.deck_id = d.id
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        GROUP BY d.id, d.slug, d.title, d.description
        ORDER BY d.id
    """
    with get_connection() as connection:
        rows = connection.execute(query).fetchall()

    decks: list[DeckSummary] = []
    for row in rows:
        total_cards = row["total_cards"]
        reviewed_cards = row["reviewed_cards"]
        known_cards = row["known_cards"]
        completion_ratio = reviewed_cards / total_cards if total_cards else 0.0
        decks.append(
            DeckSummary(
                id=row["id"],
                slug=row["slug"],
                title=row["title"],
                description=row["description"],
                total_cards=total_cards,
                reviewed_cards=reviewed_cards,
                known_cards=known_cards,
                unknown_cards=row["unknown_cards"],
                completion_ratio=completion_ratio,
                is_completed=total_cards > 0 and known_cards == total_cards,
            )
        )
    return decks


@app.get("/api/decks/{deck_id}/review", response_model=ReviewCard)
def get_review_card(deck_id: int) -> ReviewCard:
    deck_exists_query = "SELECT 1 FROM decks WHERE id = ?"
    card_query = """
        SELECT
            c.id AS card_id,
            c.deck_id,
            c.spanish_text,
            c.english_text,
            c.part_of_speech,
            c.definition_en,
            c.main_translations_es,
            c.collocations,
            c.example_sentence,
            c.example_es,
            c.example_en,
            CASE
                WHEN cp.last_result IS NULL THEN 0
                WHEN cp.last_result = 'unknown' THEN 1
                ELSE 2
            END AS review_stage,
            COALESCE(cp.known_count, 0) AS known_count,
            COALESCE(cp.unknown_count, 0) AS unknown_count,
            cp.last_reviewed_at
        FROM cards c
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        WHERE c.deck_id = ?
        ORDER BY
            review_stage ASC,
            CASE WHEN cp.last_result = 'unknown' THEN COALESCE(cp.unknown_count, 0) * -1 ELSE 0 END ASC,
            CASE WHEN cp.last_result = 'known' THEN COALESCE(cp.known_count, 0) ELSE 0 END ASC,
            COALESCE(cp.last_reviewed_at, '1970-01-01T00:00:00+00:00') ASC,
            c.id ASC
        LIMIT 1
    """
    with get_connection() as connection:
        deck = connection.execute(deck_exists_query, (deck_id,)).fetchone()
        if deck is None:
            raise HTTPException(status_code=404, detail="Deck not found")
        row = connection.execute(card_query, (deck_id,)).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Deck has no cards")

    return ReviewCard(
        card_id=row["card_id"],
        deck_id=row["deck_id"],
        prompt_es=row["spanish_text"],
        answer_en=row["english_text"],
        part_of_speech=row["part_of_speech"],
        definition_en=row["definition_en"],
        main_translations_es=_decode_json_list(row["main_translations_es"]),
        collocations=_decode_json_list(row["collocations"]),
        example_sentence=row["example_sentence"],
        example_es=row["example_es"],
        example_en=row["example_en"],
    )


@app.get("/api/decks/{deck_id}/progress", response_model=DeckProgress)
def get_deck_progress(deck_id: int) -> DeckProgress:
    query = """
        SELECT
            d.id AS deck_id,
            COUNT(c.id) AS total_cards,
            COALESCE(SUM(CASE WHEN cp.last_result IS NOT NULL THEN 1 ELSE 0 END), 0) AS reviewed_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'known' THEN 1 ELSE 0 END), 0) AS known_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cards
        FROM decks d
        LEFT JOIN cards c ON c.deck_id = d.id
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        WHERE d.id = ?
        GROUP BY d.id
    """
    with get_connection() as connection:
        row = connection.execute(query, (deck_id,)).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Deck not found")

    total_cards = row["total_cards"]
    reviewed_cards = row["reviewed_cards"]
    known_cards = row["known_cards"]
    return DeckProgress(
        deck_id=row["deck_id"],
        total_cards=total_cards,
        reviewed_cards=reviewed_cards,
        known_cards=known_cards,
        unknown_cards=row["unknown_cards"],
        completion_ratio=reviewed_cards / total_cards if total_cards else 0.0,
        is_completed=total_cards > 0 and known_cards == total_cards,
    )


@app.post("/api/reviews", response_model=ReviewResult)
def submit_review(payload: ReviewSubmission) -> ReviewResult:
    now = datetime.now(timezone.utc).isoformat()
    card_query = "SELECT id FROM cards WHERE id = ?"
    progress_query = "SELECT known_count, unknown_count FROM card_progress WHERE card_id = ?"

    with get_connection() as connection:
        card = connection.execute(card_query, (payload.card_id,)).fetchone()
        if card is None:
            raise HTTPException(status_code=404, detail="Card not found")

        existing = connection.execute(progress_query, (payload.card_id,)).fetchone()
        known_count = existing["known_count"] if existing else 0
        unknown_count = existing["unknown_count"] if existing else 0

        if payload.result == "known":
            known_count += 1
        else:
            unknown_count += 1

        connection.execute(
            """
            INSERT INTO card_progress (card_id, known_count, unknown_count, last_result, last_reviewed_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(card_id) DO UPDATE SET
                known_count = excluded.known_count,
                unknown_count = excluded.unknown_count,
                last_result = excluded.last_result,
                last_reviewed_at = excluded.last_reviewed_at
            """,
            (payload.card_id, known_count, unknown_count, payload.result, now),
        )
        connection.commit()

    return ReviewResult(
        card_id=payload.card_id,
        result=payload.result,
        reviewed_at=datetime.fromisoformat(now),
        known_count=known_count,
        unknown_count=unknown_count,
    )


def _decode_json_list(value: str | None) -> list[str]:
    if not value:
        return []

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []

    return [item for item in parsed if isinstance(item, str)]
