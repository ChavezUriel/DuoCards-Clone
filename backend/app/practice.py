from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
import sqlite3
from typing import Literal

PracticeMode = Literal["new_material", "review"]
FocusMode = Literal["auto", "new_material", "review"]
InterleavingIntensity = Literal["low", "medium", "high"]


@dataclass(slots=True, frozen=True)
class PracticeSettings:
    new_block_size: int = 7
    review_batch_size: int = 30
    interleaving_intensity: InterleavingIntensity = "medium"
    focus_mode: FocusMode = "auto"


def start_or_resume_session(connection: sqlite3.Connection, settings: PracticeSettings) -> int:
    active_row = connection.execute(
        "SELECT id FROM practice_sessions WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 1"
    ).fetchone()
    if active_row is not None:
        return active_row["id"]

    mode = _choose_session_mode(connection, settings)
    created_at = _utc_now_iso()
    cursor = connection.execute(
        """
        INSERT INTO practice_sessions (
            status,
            scope,
            mode,
            focus_mode,
            new_block_size,
            review_batch_size,
            interleaving_intensity,
            created_at,
            updated_at
        )
        VALUES ('active', 'global', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            mode,
            settings.focus_mode,
            settings.new_block_size,
            settings.review_batch_size,
            settings.interleaving_intensity,
            created_at,
            created_at,
        ),
    )
    session_id = cursor.lastrowid

    if mode == "new_material":
        cards = _select_new_material_cards(connection, settings)
    else:
        cards = _select_review_cards(connection, settings)

    if not cards:
        connection.execute(
            "UPDATE practice_sessions SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
            (created_at, created_at, session_id),
        )
        raise ValueError("No cards are available for smart practice")

    for queue_position, card in enumerate(cards):
        connection.execute(
            """
            INSERT INTO practice_session_cards (session_id, card_id, queue_position)
            VALUES (?, ?, ?)
            """,
            (session_id, card["card_id"], queue_position),
        )

    return session_id


def get_session_snapshot(connection: sqlite3.Connection, session_id: int) -> dict[str, object] | None:
    summary = connection.execute(
        """
        SELECT
            ps.id AS session_id,
            ps.status,
            ps.mode,
            ps.focus_mode,
            ps.new_block_size,
            ps.review_batch_size,
            ps.interleaving_intensity,
            COUNT(psc.card_id) AS total_cards,
            COALESCE(SUM(CASE WHEN psc.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_cards,
            COALESCE(SUM(CASE WHEN psc.status = 'pending' THEN 1 ELSE 0 END), 0) AS remaining_cards
        FROM practice_sessions ps
        LEFT JOIN practice_session_cards psc ON psc.session_id = ps.id
        WHERE ps.id = ?
        GROUP BY ps.id
        """,
        (session_id,),
    ).fetchone()

    if summary is None:
        return None

    current_card = connection.execute(
        """
        SELECT
            psc.card_id,
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
            psc.times_presented
        FROM practice_session_cards psc
        JOIN cards c ON c.id = psc.card_id
        JOIN decks d ON d.id = c.deck_id
        WHERE psc.session_id = ? AND psc.status = 'pending' AND c.is_enabled = 1
        ORDER BY psc.queue_position ASC
        LIMIT 1
        """,
        (session_id,),
    ).fetchone()

    return {
        "session_id": summary["session_id"],
        "status": summary["status"],
        "mode": summary["mode"],
        "focus_mode": summary["focus_mode"],
        "new_block_size": summary["new_block_size"],
        "review_batch_size": summary["review_batch_size"],
        "interleaving_intensity": summary["interleaving_intensity"],
        "total_cards": summary["total_cards"],
        "completed_cards": summary["completed_cards"],
        "remaining_cards": summary["remaining_cards"],
        "current_card": current_card,
    }


def submit_session_review(
    connection: sqlite3.Connection,
    *,
    session_id: int,
    card_id: int,
    result: Literal["known", "unknown"],
) -> dict[str, int | str | None]:
    session = connection.execute(
        "SELECT id, mode, status FROM practice_sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    if session is None:
        raise ValueError("Smart practice session not found")
    if session["status"] != "active":
        raise ValueError("Smart practice session is no longer active")

    entry = connection.execute(
        """
        SELECT psc.id, psc.card_id, psc.queue_position
        FROM practice_session_cards psc
        WHERE psc.session_id = ? AND psc.status = 'pending'
        ORDER BY psc.queue_position ASC
        LIMIT 1
        """,
        (session_id,),
    ).fetchone()
    if entry is None:
        _complete_session(connection, session_id)
        raise ValueError("Smart practice session is already complete")
    if entry["card_id"] != card_id:
        raise ValueError("Submitted card does not match the active smart practice card")

    progress = _update_card_progress(connection, card_id=card_id, result=result)
    now = _utc_now_iso()
    if session["mode"] == "new_material":
        should_repeat = progress["initial_mastered_at"] is None
    else:
        should_repeat = result == "unknown"

    if should_repeat:
        next_position = _next_queue_position(connection, session_id)
        connection.execute(
            """
            UPDATE practice_session_cards
            SET queue_position = ?, times_presented = times_presented + 1, last_presented_at = ?, last_result = ?
            WHERE id = ?
            """,
            (next_position, now, result, entry["id"]),
        )
    else:
        connection.execute(
            """
            UPDATE practice_session_cards
            SET status = 'completed', times_presented = times_presented + 1, last_presented_at = ?, last_result = ?
            WHERE id = ?
            """,
            (now, result, entry["id"]),
        )

    pending_count = connection.execute(
        "SELECT COUNT(*) AS total FROM practice_session_cards WHERE session_id = ? AND status = 'pending'",
        (session_id,),
    ).fetchone()["total"]

    if pending_count == 0:
        _complete_session(connection, session_id)
    else:
        connection.execute(
            "UPDATE practice_sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )

    return progress


def _choose_session_mode(connection: sqlite3.Connection, settings: PracticeSettings) -> PracticeMode:
    counts = connection.execute(
        """
        SELECT
            COALESCE(SUM(CASE WHEN cp.initial_mastered_at IS NULL THEN 1 ELSE 0 END), 0) AS unmastered_count,
            COALESCE(SUM(CASE WHEN cp.initial_mastered_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS learned_count
        FROM cards c
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        WHERE c.is_enabled = 1
        """
    ).fetchone()
    unmastered_count = counts["unmastered_count"]
    learned_count = counts["learned_count"]

    if settings.focus_mode == "new_material":
        if unmastered_count > 0:
            return "new_material"
        if learned_count > 0:
            return "review"
    elif settings.focus_mode == "review":
        if learned_count > 0:
            return "review"
        if unmastered_count > 0:
            return "new_material"
    else:
        if unmastered_count > 0 and learned_count > 0:
            last_mode_row = connection.execute(
                "SELECT mode FROM practice_sessions WHERE status != 'active' ORDER BY updated_at DESC, id DESC LIMIT 1"
            ).fetchone()
            last_mode = last_mode_row["mode"] if last_mode_row is not None else None
            if last_mode == "new_material" and learned_count >= max(10, settings.review_batch_size // 2):
                return "review"
            if last_mode == "review":
                return "new_material"
            if learned_count >= max(10, settings.review_batch_size // 2):
                return "review"
            return "new_material"
        if unmastered_count > 0:
            return "new_material"
        if learned_count > 0:
            return "review"

    raise ValueError("No cards are available for smart practice")


def _select_new_material_cards(connection: sqlite3.Connection, settings: PracticeSettings) -> list[sqlite3.Row]:
    rows = connection.execute(
        """
        SELECT
            c.id AS card_id,
            c.deck_id,
            d.title AS deck_title,
            COALESCE(c.section_name, d.title) AS section_name,
            COALESCE(cp.known_streak, 0) AS known_streak,
            COALESCE(cp.unknown_count, 0) AS unknown_count,
            cp.last_result,
            cp.last_reviewed_at
        FROM cards c
        JOIN decks d ON d.id = c.deck_id
        LEFT JOIN card_progress cp ON cp.card_id = c.id
        WHERE c.is_enabled = 1 AND (cp.initial_mastered_at IS NULL OR cp.card_id IS NULL)
        ORDER BY
            CASE WHEN cp.last_result IS NULL THEN 1 ELSE 0 END ASC,
            COALESCE(cp.known_streak, 0) DESC,
            COALESCE(cp.unknown_count, 0) DESC,
            COALESCE(cp.last_reviewed_at, '1970-01-01T00:00:00+00:00') ASC,
            c.id ASC
        """
    ).fetchall()
    return _interleave_rows(rows, limit=settings.new_block_size, intensity=settings.interleaving_intensity)


def _select_review_cards(connection: sqlite3.Connection, settings: PracticeSettings) -> list[sqlite3.Row]:
    rows = connection.execute(
        """
        SELECT
            c.id AS card_id,
            c.deck_id,
            d.title AS deck_title,
            COALESCE(c.section_name, d.title) AS section_name,
            COALESCE(cp.unknown_count, 0) AS unknown_count,
            COALESCE(cp.known_count, 0) AS known_count,
            cp.last_reviewed_at,
            cp.initial_mastered_at
        FROM cards c
        JOIN decks d ON d.id = c.deck_id
        JOIN card_progress cp ON cp.card_id = c.id
        WHERE c.is_enabled = 1 AND cp.initial_mastered_at IS NOT NULL
        ORDER BY
            COALESCE(cp.unknown_count, 0) DESC,
            COALESCE(cp.last_reviewed_at, cp.initial_mastered_at, '1970-01-01T00:00:00+00:00') ASC,
            c.id ASC
        """
    ).fetchall()
    return _interleave_rows(rows, limit=settings.review_batch_size, intensity=settings.interleaving_intensity)


def _interleave_rows(
    rows: list[sqlite3.Row],
    *,
    limit: int,
    intensity: InterleavingIntensity,
) -> list[sqlite3.Row]:
    if intensity == "low":
        return rows[:limit]

    grouped: dict[str, deque[sqlite3.Row]] = defaultdict(deque)
    for row in rows:
        grouped[row["section_name"]].append(row)

    result: list[sqlite3.Row] = []
    last_section: str | None = None

    while len(result) < limit:
        available_sections = [section for section, items in grouped.items() if items]
        if not available_sections:
            break

        if intensity == "high":
            preferred_sections = [section for section in available_sections if section != last_section] or available_sections
            next_section = max(preferred_sections, key=lambda section: len(grouped[section]))
        else:
            preferred_sections = [section for section in available_sections if section != last_section]
            if preferred_sections:
                next_section = preferred_sections[0]
            else:
                next_section = available_sections[0]

        result.append(grouped[next_section].popleft())
        last_section = next_section

    return result


def _update_card_progress(
    connection: sqlite3.Connection,
    *,
    card_id: int,
    result: Literal["known", "unknown"],
) -> dict[str, int | str | None]:
    existing = connection.execute(
        "SELECT known_count, unknown_count, known_streak, initial_mastered_at FROM card_progress WHERE card_id = ?",
        (card_id,),
    ).fetchone()
    known_count = existing["known_count"] if existing is not None else 0
    unknown_count = existing["unknown_count"] if existing is not None else 0
    known_streak = existing["known_streak"] if existing is not None and "known_streak" in existing.keys() else 0
    initial_mastered_at = existing["initial_mastered_at"] if existing is not None else None
    now = _utc_now_iso()

    if result == "known":
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
        (card_id, known_count, unknown_count, known_streak, result, now, initial_mastered_at),
    )

    return {
        "known_count": known_count,
        "unknown_count": unknown_count,
        "known_streak": known_streak,
        "initial_mastered_at": initial_mastered_at,
    }


def _next_queue_position(connection: sqlite3.Connection, session_id: int) -> int:
    row = connection.execute(
        "SELECT COALESCE(MAX(queue_position), -1) AS next_position FROM practice_session_cards WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    return row["next_position"] + 1


def _complete_session(connection: sqlite3.Connection, session_id: int) -> None:
    now = _utc_now_iso()
    connection.execute(
        "UPDATE practice_sessions SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
        (now, now, session_id),
    )


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()