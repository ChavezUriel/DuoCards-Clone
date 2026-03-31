from __future__ import annotations

from datetime import datetime, timezone
import json
import sqlite3

from fastapi import FastAPI, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm

from .db import get_connection, initialize_database
from . import auth
from .practice import (
    PracticeSettings,
    get_session_snapshot,
    start_or_resume_session,
    submit_session_review,
)
from .schemas import (
    CardUpdateRequest,
    CardVisibilityResult,
    CardVisibilityUpdate,
    DeckHomeSelectionResult,
    DeckHomeSelectionUpdate,
    DeckPreview,
    DeckPreviewCard,
    DeckProgress,
    DeckSmartPracticeResult,
    DeckSmartPracticeUpdate,
    DeckSummary,
    HealthResponse,
    ReviewCard,
    ReviewResult,
    ReviewSubmission,
    SmartPracticeReviewResult,
    SmartPracticeReviewSubmission,
    SmartPracticeSession,
    SmartPracticeSessionSummary,
    SmartPracticeStartRequest,
    Token,
    UserCreate,
    UserResponse,
)

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

@app.post("/api/auth/register", response_model=UserResponse)
def register_user(user: UserCreate):
    with get_connection() as connection:
        existing_user = connection.execute(
            "SELECT id FROM users WHERE email = ?", (user.email,)
        ).fetchone()
        if existing_user:
            raise HTTPException(status_code=400, detail="Email already registered")
        
        hashed_password = auth.get_password_hash(user.password)
        cursor = connection.execute(
            "INSERT INTO users (email, full_name, hashed_password) VALUES (?, ?, ?)",
            (user.email, user.full_name, hashed_password)
        )
        connection.commit()
        user_id = cursor.lastrowid
        
        return UserResponse(id=user_id, email=user.email, full_name=user.full_name)

@app.post("/api/auth/token", response_model=Token)
def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends()):
    with get_connection() as connection:
        user_row = connection.execute(
            "SELECT id, email, full_name, hashed_password FROM users WHERE email = ?",
            (form_data.username,)
        ).fetchone()
        
    if not user_row or not auth.verify_password(form_data.password, user_row["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
        
    access_token = auth.create_access_token(data={"sub": user_row["email"]})
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/api/auth/me", response_model=UserResponse)
def read_users_me(email: str = Depends(auth.get_current_user_email)):
    with get_connection() as connection:
        user_row = connection.execute(
            "SELECT id, email, full_name FROM users WHERE email = ?",
            (email,)
        ).fetchone()
    
    if user_row is None:
        raise HTTPException(status_code=404, detail="User not found")
        
    return UserResponse(id=user_row["id"], email=user_row["email"], full_name=user_row["full_name"])

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
            d.is_selected_on_home,
            d.is_enabled_in_smart_practice,
            COUNT(c.id) AS total_cards,
            COALESCE(SUM(CASE WHEN cp.last_result IS NOT NULL THEN 1 ELSE 0 END), 0) AS reviewed_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'known' THEN 1 ELSE 0 END), 0) AS known_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cards
        FROM decks d
        LEFT JOIN cards c ON c.deck_id = d.id AND c.is_enabled = 1 AND c.generation_phase = 'refined'
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        WHERE d.is_selected_on_home = 1
        GROUP BY d.id, d.slug, d.title, d.description, d.is_selected_on_home, d.is_enabled_in_smart_practice
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
                is_selected_on_home=bool(row["is_selected_on_home"]),
                is_enabled_in_smart_practice=bool(row["is_enabled_in_smart_practice"]),
                total_cards=total_cards,
                reviewed_cards=reviewed_cards,
                known_cards=known_cards,
                unknown_cards=row["unknown_cards"],
                completion_ratio=completion_ratio,
                is_completed=total_cards > 0 and known_cards == total_cards,
            )
        )
    return decks


@app.get("/api/decks/market", response_model=list[DeckSummary])
def list_market_decks() -> list[DeckSummary]:
    query = """
        SELECT
            d.id,
            d.slug,
            d.title,
            d.description,
            d.is_selected_on_home,
            d.is_enabled_in_smart_practice,
            COUNT(c.id) AS total_cards,
            COALESCE(SUM(CASE WHEN cp.last_result IS NOT NULL THEN 1 ELSE 0 END), 0) AS reviewed_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'known' THEN 1 ELSE 0 END), 0) AS known_cards,
            COALESCE(SUM(CASE WHEN cp.last_result = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cards
        FROM decks d
        LEFT JOIN cards c ON c.deck_id = d.id AND c.is_enabled = 1 AND c.generation_phase = 'refined'
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        GROUP BY d.id, d.slug, d.title, d.description, d.is_selected_on_home, d.is_enabled_in_smart_practice
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
                is_selected_on_home=bool(row["is_selected_on_home"]),
                is_enabled_in_smart_practice=bool(row["is_enabled_in_smart_practice"]),
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
    deck_exists_query = "SELECT 1 FROM decks WHERE id = ? AND is_selected_on_home = 1"
    card_query = """
        SELECT
            c.id AS card_id,
            c.deck_id,
            d.title AS deck_title,
            COALESCE(c.section_name, d.title) AS section_name,
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
        JOIN decks d ON d.id = c.deck_id
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        WHERE c.deck_id = ? AND c.is_enabled = 1 AND c.generation_phase = 'refined' AND d.is_selected_on_home = 1
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
            raise HTTPException(status_code=404, detail="Deck not found or not on home")
        row = connection.execute(card_query, (deck_id,)).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Deck has no cards")

    return _build_review_card(row)


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
        LEFT JOIN cards c ON c.deck_id = d.id AND c.is_enabled = 1 AND c.generation_phase = 'refined'
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        WHERE d.id = ? AND d.is_selected_on_home = 1
        GROUP BY d.id
    """
    with get_connection() as connection:
        row = connection.execute(query, (deck_id,)).fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="Deck not found or not on home")

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


@app.get("/api/decks/{deck_id}/preview", response_model=DeckPreview)
def get_deck_preview(deck_id: int) -> DeckPreview:
    deck_query = """
        SELECT id, title, description
        FROM decks
        WHERE id = ?
    """
    cards_query = """
        SELECT
            c.id AS card_id,
            c.spanish_text,
            c.english_text,
            c.is_enabled,
            c.part_of_speech,
            c.definition_en,
            c.main_translations_es,
            c.collocations,
            c.example_sentence,
            c.example_es,
            c.example_en,
            COALESCE(c.section_name, d.title) AS section_name
        FROM cards c
        JOIN decks d ON d.id = c.deck_id
        WHERE c.deck_id = ? AND c.generation_phase = 'refined'
        ORDER BY COALESCE(c.section_name, d.title) ASC, c.id ASC
    """

    with get_connection() as connection:
        deck_row = connection.execute(deck_query, (deck_id,)).fetchone()
        if deck_row is None:
            raise HTTPException(status_code=404, detail="Deck not found or not on home")

        card_rows = connection.execute(cards_query, (deck_id,)).fetchall()

    cards = [_build_deck_preview_card(row) for row in card_rows]

    return DeckPreview(
        deck_id=deck_row["id"],
        deck_title=deck_row["title"],
        deck_description=deck_row["description"],
        total_cards=len(cards),
        cards=cards,
    )


def _clear_pending_practice_cards_for_deck(
    connection: sqlite3.Connection,
    deck_id: int,
    now: str,
) -> None:
    affected_sessions = connection.execute(
        """
        SELECT DISTINCT psc.session_id
        FROM practice_session_cards psc
        JOIN cards c ON c.id = psc.card_id
        WHERE c.deck_id = ? AND psc.status = 'pending'
        """,
        (deck_id,),
    ).fetchall()
    connection.execute(
        """
        DELETE FROM practice_session_cards
        WHERE id IN (
            SELECT psc.id
            FROM practice_session_cards psc
            JOIN cards c ON c.id = psc.card_id
            WHERE c.deck_id = ? AND psc.status = 'pending'
        )
        """,
        (deck_id,),
    )

    for session_row in affected_sessions:
        pending_total = connection.execute(
            "SELECT COUNT(*) AS total FROM practice_session_cards WHERE session_id = ? AND status = 'pending'",
            (session_row["session_id"],),
        ).fetchone()["total"]
        if pending_total == 0:
            connection.execute(
                "UPDATE practice_sessions SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'",
                (now, now, session_row["session_id"]),
            )
        else:
            connection.execute(
                "UPDATE practice_sessions SET updated_at = ? WHERE id = ? AND status = 'active'",
                (now, session_row["session_id"]),
            )


@app.post("/api/reviews", response_model=ReviewResult)
def submit_review(payload: ReviewSubmission) -> ReviewResult:
    now = datetime.now(timezone.utc).isoformat()
    card_query = "SELECT id FROM cards WHERE id = ? AND is_enabled = 1 AND generation_phase = 'refined'"
    progress_query = "SELECT known_count, unknown_count, known_streak, initial_mastered_at FROM card_progress WHERE card_id = ?"

    with get_connection() as connection:
        card = connection.execute(card_query, (payload.card_id,)).fetchone()
        if card is None:
            raise HTTPException(status_code=404, detail="Card not found")

        existing = connection.execute(progress_query, (payload.card_id,)).fetchone()
        known_count = existing["known_count"] if existing else 0
        unknown_count = existing["unknown_count"] if existing else 0
        known_streak = existing["known_streak"] if existing else 0
        initial_mastered_at = existing["initial_mastered_at"] if existing else None

        if payload.result == "known":
            known_count += 1
            known_streak += 1
            if known_streak >= 2 and initial_mastered_at is None:
                initial_mastered_at = now
        else:
            unknown_count += 1
            known_streak = 0

        connection.execute(
            """
            INSERT INTO card_progress (
                card_id,
                known_count,
                unknown_count,
                known_streak,
                last_result,
                last_reviewed_at,
                initial_mastered_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(card_id) DO UPDATE SET
                known_count = excluded.known_count,
                unknown_count = excluded.unknown_count,
                known_streak = excluded.known_streak,
                last_result = excluded.last_result,
                last_reviewed_at = excluded.last_reviewed_at,
                initial_mastered_at = excluded.initial_mastered_at
            """,
            (
                payload.card_id,
                known_count,
                unknown_count,
                known_streak,
                payload.result,
                now,
                initial_mastered_at,
            ),
        )
        connection.commit()

    return ReviewResult(
        card_id=payload.card_id,
        result=payload.result,
        reviewed_at=datetime.fromisoformat(now),
        known_count=known_count,
        unknown_count=unknown_count,
    )


@app.patch("/api/cards/{card_id}/visibility", response_model=CardVisibilityResult)
def update_card_visibility(
    card_id: int, payload: CardVisibilityUpdate
) -> CardVisibilityResult:
    now = datetime.now(timezone.utc).isoformat()

    with get_connection() as connection:
        card_row = connection.execute(
            "SELECT c.id, c.deck_id, c.is_enabled FROM cards c WHERE c.id = ?",
            (card_id,),
        ).fetchone()
        if card_row is None:
            raise HTTPException(status_code=404, detail="Card not found")

        next_enabled_value = 1 if payload.is_enabled else 0
        connection.execute(
            "UPDATE cards SET is_enabled = ? WHERE id = ?",
            (next_enabled_value, card_id),
        )

        if not payload.is_enabled:
            _clear_pending_practice_cards_for_deck(
                connection, deck_id=card_row["deck_id"], now=now
            )

        connection.commit()

    return CardVisibilityResult(
        card_id=card_id,
        deck_id=card_row["deck_id"],
        is_enabled=payload.is_enabled,
    )


@app.patch(
    "/api/decks/{deck_id}/home-selection", response_model=DeckHomeSelectionResult
)
def update_deck_home_selection(
    deck_id: int,
    payload: DeckHomeSelectionUpdate,
) -> DeckHomeSelectionResult:
    now = datetime.now(timezone.utc).isoformat()

    with get_connection() as connection:
        deck_row = connection.execute(
            "SELECT id, is_selected_on_home FROM decks WHERE id = ?",
            (deck_id,),
        ).fetchone()
        if deck_row is None:
            raise HTTPException(status_code=404, detail="Deck not found")

        next_selected_value = 1 if payload.is_selected_on_home else 0
        connection.execute(
            "UPDATE decks SET is_selected_on_home = ? WHERE id = ?",
            (next_selected_value, deck_id),
        )

        if not payload.is_selected_on_home:
            _clear_pending_practice_cards_for_deck(connection, deck_id=deck_id, now=now)

        connection.commit()

    return DeckHomeSelectionResult(
        deck_id=deck_id, is_selected_on_home=payload.is_selected_on_home
    )


@app.patch(
    "/api/decks/{deck_id}/smart-practice-inclusion",
    response_model=DeckSmartPracticeResult,
)
def update_deck_smart_practice_inclusion(
    deck_id: int,
    payload: DeckSmartPracticeUpdate,
) -> DeckSmartPracticeResult:
    now = datetime.now(timezone.utc).isoformat()

    with get_connection() as connection:
        deck_row = connection.execute(
            "SELECT id, is_selected_on_home, is_enabled_in_smart_practice FROM decks WHERE id = ?",
            (deck_id,),
        ).fetchone()
        if deck_row is None:
            raise HTTPException(status_code=404, detail="Deck not found or not on home")
        if deck_row["is_selected_on_home"] == 0:
            raise HTTPException(status_code=404, detail="Deck not found or not on home")

        next_enabled_value = 1 if payload.is_enabled_in_smart_practice else 0
        connection.execute(
            "UPDATE decks SET is_enabled_in_smart_practice = ? WHERE id = ?",
            (next_enabled_value, deck_id),
        )

        if not payload.is_enabled_in_smart_practice:
            _clear_pending_practice_cards_for_deck(connection, deck_id=deck_id, now=now)

        connection.commit()

    return DeckSmartPracticeResult(
        deck_id=deck_id,
        is_enabled_in_smart_practice=payload.is_enabled_in_smart_practice,
    )


@app.patch("/api/cards/{card_id}", response_model=DeckPreviewCard)
def update_card(card_id: int, payload: CardUpdateRequest) -> DeckPreviewCard:
    with get_connection() as connection:
        existing_card = connection.execute(
            "SELECT c.id FROM cards c WHERE c.id = ?",
            (card_id,),
        ).fetchone()
        if existing_card is None:
            raise HTTPException(status_code=404, detail="Card not found")

        connection.execute(
            """
            UPDATE cards
            SET
                spanish_text = ?,
                english_text = ?,
                section_name = ?,
                part_of_speech = ?,
                definition_en = ?,
                main_translations_es = ?,
                collocations = ?,
                example_sentence = ?,
                example_es = ?,
                example_en = ?
            WHERE id = ?
            """,
            (
                _normalize_required_text(payload.prompt_es, "prompt_es"),
                _normalize_required_text(payload.answer_en, "answer_en"),
                _normalize_optional_text(payload.section_name),
                _normalize_optional_text(payload.part_of_speech),
                _normalize_optional_text(payload.definition_en),
                json.dumps(
                    _normalize_text_items(payload.main_translations_es),
                    ensure_ascii=False,
                ),
                json.dumps(
                    _normalize_text_items(payload.collocations), ensure_ascii=False
                ),
                _normalize_optional_text(payload.example_sentence),
                _normalize_optional_text(payload.example_es),
                _normalize_optional_text(payload.example_en),
                card_id,
            ),
        )

        updated_row = connection.execute(
            """
            SELECT
                c.id AS card_id,
                c.spanish_text,
                c.english_text,
                c.is_enabled,
                c.part_of_speech,
                c.definition_en,
                c.main_translations_es,
                c.collocations,
                c.example_sentence,
                c.example_es,
                c.example_en,
                COALESCE(c.section_name, d.title) AS section_name
            FROM cards c
            JOIN decks d ON d.id = c.deck_id
            WHERE c.id = ?
            """,
            (card_id,),
        ).fetchone()
        connection.commit()

    return _build_deck_preview_card(updated_row)


@app.post("/api/practice/sessions", response_model=SmartPracticeSession)
def start_smart_practice_session(
    payload: SmartPracticeStartRequest,
) -> SmartPracticeSession:
    settings = PracticeSettings(
        new_block_size=payload.settings.new_block_size,
        review_batch_size=payload.settings.review_batch_size,
        interleaving_intensity=payload.settings.interleaving_intensity,
        focus_mode=payload.settings.focus_mode,
    )
    with get_connection() as connection:
        try:
            session_id = start_or_resume_session(connection, settings)
            connection.commit()
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        snapshot = get_session_snapshot(connection, session_id)

    if snapshot is None:
        raise HTTPException(status_code=404, detail="Smart practice session not found")
    return _build_smart_practice_session(snapshot)


@app.get("/api/practice/sessions/{session_id}", response_model=SmartPracticeSession)
def get_smart_practice_session(session_id: int) -> SmartPracticeSession:
    with get_connection() as connection:
        snapshot = get_session_snapshot(connection, session_id)

    if snapshot is None:
        raise HTTPException(status_code=404, detail="Smart practice session not found")
    return _build_smart_practice_session(snapshot)


@app.post(
    "/api/practice/sessions/{session_id}/reviews",
    response_model=SmartPracticeReviewResult,
)
def submit_smart_practice_review(
    session_id: int,
    payload: SmartPracticeReviewSubmission,
) -> SmartPracticeReviewResult:
    with get_connection() as connection:
        try:
            submit_session_review(
                connection,
                session_id=session_id,
                card_id=payload.card_id,
                result=payload.result,
            )
            snapshot = get_session_snapshot(connection, session_id)
            connection.commit()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if snapshot is None:
        raise HTTPException(status_code=404, detail="Smart practice session not found")
    return SmartPracticeReviewResult(session=_build_smart_practice_session(snapshot))


def _decode_json_list(value: str | None) -> list[str]:
    if not value:
        return []

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []

    return [item for item in parsed if isinstance(item, str)]


def _normalize_required_text(value: str, field_name: str) -> str:
    normalized = _normalize_optional_text(value)
    if normalized is None:
        raise HTTPException(
            status_code=422, detail=f"{field_name} must be a non-empty string"
        )
    return normalized


def _normalize_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _normalize_text_items(values: list[str]) -> list[str]:
    normalized_items: list[str] = []
    seen_items: set[str] = set()

    for value in values:
        normalized_value = _normalize_optional_text(value)
        if normalized_value is None:
            continue
        lookup_value = normalized_value.casefold()
        if lookup_value in seen_items:
            continue
        seen_items.add(lookup_value)
        normalized_items.append(normalized_value)

    return normalized_items


def _build_smart_practice_session(snapshot: dict[str, object]) -> SmartPracticeSession:
    summary = SmartPracticeSessionSummary(
        session_id=int(snapshot["session_id"]),
        status=str(snapshot["status"]),
        mode=str(snapshot["mode"]),
        focus_mode=str(snapshot["focus_mode"]),
        total_cards=int(snapshot["total_cards"]),
        completed_cards=int(snapshot["completed_cards"]),
        remaining_cards=int(snapshot["remaining_cards"]),
        new_block_size=int(snapshot["new_block_size"]),
        review_batch_size=int(snapshot["review_batch_size"]),
        interleaving_intensity=str(snapshot["interleaving_intensity"]),
    )
    current_card_row = snapshot["current_card"]
    current_card = None
    if current_card_row is not None:
        current_card = _build_review_card(current_card_row)

    return SmartPracticeSession(summary=summary, current_card=current_card)


def _build_review_card(row: object) -> ReviewCard:
    return ReviewCard(
        card_id=row["card_id"],
        deck_id=row["deck_id"],
        deck_title=row["deck_title"],
        section_name=row["section_name"],
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


def _build_deck_preview_card(row: object) -> DeckPreviewCard:
    return DeckPreviewCard(
        card_id=row["card_id"],
        prompt_es=row["spanish_text"],
        answer_en=row["english_text"],
        section_name=row["section_name"],
        is_enabled=bool(row["is_enabled"]),
        part_of_speech=row["part_of_speech"],
        definition_en=row["definition_en"],
        main_translations_es=_decode_json_list(row["main_translations_es"]),
        collocations=_decode_json_list(row["collocations"]),
        example_sentence=row["example_sentence"],
        example_es=row["example_es"],
        example_en=row["example_en"],
    )
