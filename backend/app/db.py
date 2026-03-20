from __future__ import annotations

from dataclasses import dataclass
import sqlite3
from pathlib import Path
from typing import Any, Literal

import json

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATABASE_PATH = DATA_DIR / "duocards.db"
DECK_EXPANSION_PATTERN = "deck_expansions*.json"

DEFAULT_LANGUAGE_FROM = "es"
DEFAULT_LANGUAGE_TO = "en"


@dataclass(slots=True)
class DeckWriteResult:
    deck_id: int
    created_deck: bool
    inserted_cards: int
    updated_cards: int
    deleted_cards: int
    total_cards: int

SEED_DECKS: list[dict[str, Any]] = [
    {
        "slug": "basics",
        "title": "English Basics",
        "description": "Everyday words and short expressions for beginners.",
        "cards": [
            {
                "spanish": "Hola",
                "english": "Hello",
                "part_of_speech": "interjection",
                "definition_en": "A word used when meeting someone or starting a conversation.",
                "main_translations_es": ["hola", "buenas"],
                "collocations": ["say hello", "hello everyone", "hello there"],
                "example_sentence": "Hello, welcome to our English class.",
                "example_es": "Hola, ¿cómo estás?",
                "example_en": "Hello, how are you?",
            },
            {
                "spanish": "Gracias",
                "english": "Thank you",
                "part_of_speech": "expression",
                "definition_en": "A polite expression used to show gratitude.",
                "main_translations_es": ["gracias", "muchas gracias"],
                "collocations": ["thank you very much", "thank you for", "say thank you"],
                "example_sentence": "Thank you for coming today.",
                "example_es": "Gracias por tu ayuda.",
                "example_en": "Thank you for your help.",
            },
            {
                "spanish": "Por favor",
                "english": "Please",
                "part_of_speech": "adverb",
                "definition_en": "A polite word used when asking for something or making a request.",
                "main_translations_es": ["por favor"],
                "collocations": ["please help", "please sit down", "yes, please"],
                "example_sentence": "Please close the window before you leave.",
                "example_es": "Por favor, abre la puerta.",
                "example_en": "Please open the door.",
            },
            {
                "spanish": "Buenos días",
                "english": "Good morning",
                "part_of_speech": "expression",
                "definition_en": "A greeting used in the early part of the day.",
                "main_translations_es": ["buenos días"],
                "collocations": ["say good morning", "good morning everyone", "good morning sir"],
                "example_sentence": "Good morning, how was your weekend?",
                "example_es": "Buenos días, profesora.",
                "example_en": "Good morning, teacher.",
            },
            {
                "spanish": "¿Cuánto cuesta?",
                "english": "How much does it cost?",
                "part_of_speech": "question",
                "definition_en": "A question used to ask for the price of something.",
                "main_translations_es": ["¿cuánto cuesta?", "¿qué precio tiene?"],
                "collocations": ["how much does it cost", "cost too much", "cost a lot"],
                "example_sentence": "How much does it cost to travel by train?",
                "example_es": "¿Cuánto cuesta este libro?",
                "example_en": "How much does this book cost?",
            },
        ],
    },
    {
        "slug": "daily-life",
        "title": "Daily Life",
        "description": "Useful vocabulary for routines, places, and simple actions.",
        "cards": [
            {
                "spanish": "Trabajo",
                "english": "Work",
                "part_of_speech": "noun / verb",
                "definition_en": "Activity you do to earn money, or the act of doing a job.",
                "main_translations_es": ["trabajo", "trabajar"],
                "collocations": ["go to work", "work hard", "work from home"],
                "example_sentence": "She goes to work at eight every morning.",
                "example_es": "Voy al trabajo en autobús.",
                "example_en": "I go to work by bus.",
            },
            {
                "spanish": "Comida",
                "english": "Food",
                "part_of_speech": "noun",
                "definition_en": "Things that people or animals eat.",
                "main_translations_es": ["comida", "alimento"],
                "collocations": ["fresh food", "food market", "food delivery"],
                "example_sentence": "The food at this restaurant is excellent.",
                "example_es": "La comida está lista.",
                "example_en": "The food is ready.",
            },
            {
                "spanish": "Casa",
                "english": "House",
                "part_of_speech": "noun",
                "definition_en": "A building where people live, usually with a family.",
                "main_translations_es": ["casa", "hogar"],
                "collocations": ["house keys", "house party", "go home to the house"],
                "example_sentence": "Their house is near the river.",
                "example_es": "Mi casa está cerca.",
                "example_en": "My house is nearby.",
            },
            {
                "spanish": "Caminar",
                "english": "To walk",
                "part_of_speech": "verb",
                "definition_en": "To move forward on foot at a regular speed.",
                "main_translations_es": ["caminar", "andar"],
                "collocations": ["walk home", "walk slowly", "walk in the park"],
                "example_sentence": "We walk to school when the weather is nice.",
                "example_es": "Me gusta caminar por el parque.",
                "example_en": "I like to walk in the park.",
            },
            {
                "spanish": "Necesito ayuda",
                "english": "I need help",
                "part_of_speech": "expression",
                "definition_en": "A phrase used when you require support or assistance.",
                "main_translations_es": ["necesito ayuda", "me hace falta ayuda"],
                "collocations": ["need help with", "ask for help", "get help"],
                "example_sentence": "I need help with this exercise.",
                "example_es": "Necesito ayuda con mi tarea.",
                "example_en": "I need help with my homework.",
            },
        ],
    },
    {
        "slug": "travel",
        "title": "Travel Phrases",
        "description": "Short phrases for transport, directions, and common travel moments.",
        "cards": [
            {
                "spanish": "Aeropuerto",
                "english": "Airport",
                "part_of_speech": "noun",
                "definition_en": "A place where airplanes arrive and leave.",
                "main_translations_es": ["aeropuerto"],
                "collocations": ["airport terminal", "airport bus", "go to the airport"],
                "example_sentence": "We arrived at the airport two hours early.",
                "example_es": "El aeropuerto está lejos del centro.",
                "example_en": "The airport is far from downtown.",
            },
            {
                "spanish": "¿Dónde está la estación?",
                "english": "Where is the station?",
                "part_of_speech": "question",
                "definition_en": "A question used to ask for the location of a station.",
                "main_translations_es": ["¿dónde está la estación?"],
                "collocations": ["train station", "bus station", "station entrance"],
                "example_sentence": "Excuse me, where is the station from here?",
                "example_es": "Disculpa, ¿dónde está la estación?",
                "example_en": "Excuse me, where is the station?",
            },
            {
                "spanish": "Billete",
                "english": "Ticket",
                "part_of_speech": "noun",
                "definition_en": "A piece of paper or digital document that gives you permission to travel or enter a place.",
                "main_translations_es": ["billete", "boleto", "entrada"],
                "collocations": ["buy a ticket", "train ticket", "return ticket"],
                "example_sentence": "I bought a ticket online yesterday.",
                "example_es": "Necesito un billete para Londres.",
                "example_en": "I need a ticket to London.",
            },
            {
                "spanish": "Maleta",
                "english": "Suitcase",
                "part_of_speech": "noun",
                "definition_en": "A case used for carrying clothes and personal items when traveling.",
                "main_translations_es": ["maleta"],
                "collocations": ["pack a suitcase", "heavy suitcase", "carry a suitcase"],
                "example_sentence": "Her suitcase is too heavy to lift.",
                "example_es": "Mi maleta es negra.",
                "example_en": "My suitcase is black.",
            },
            {
                "spanish": "Estoy perdido",
                "english": "I am lost",
                "part_of_speech": "expression",
                "definition_en": "A phrase used to say that you do not know where you are or where to go.",
                "main_translations_es": ["estoy perdido", "no sé dónde estoy"],
                "collocations": ["feel lost", "get lost", "completely lost"],
                "example_sentence": "I am lost, so I need to check the map.",
                "example_es": "Estoy perdido, ¿puedes ayudarme?",
                "example_en": "I am lost, can you help me?",
            },
        ],
    },
]


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    language_from TEXT NOT NULL DEFAULT 'es',
    language_to TEXT NOT NULL DEFAULT 'en'
);

CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id INTEGER NOT NULL,
    spanish_text TEXT NOT NULL,
    english_text TEXT NOT NULL,
    part_of_speech TEXT,
    definition_en TEXT,
    main_translations_es TEXT,
    collocations TEXT,
    example_sentence TEXT,
    example_es TEXT,
    example_en TEXT,
    FOREIGN KEY (deck_id) REFERENCES decks (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS card_progress (
    card_id INTEGER PRIMARY KEY,
    known_count INTEGER NOT NULL DEFAULT 0,
    unknown_count INTEGER NOT NULL DEFAULT 0,
    last_result TEXT CHECK(last_result IN ('known', 'unknown')),
    last_reviewed_at TEXT,
    FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE CASCADE
);
"""


def get_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    with get_connection() as connection:
        connection.executescript(SCHEMA_SQL)
        _migrate_cards_table(connection)
        _seed_database(connection)
        connection.commit()


def _seed_database(connection: sqlite3.Connection) -> None:
    for deck in SEED_DECKS:
        upsert_deck(connection, deck, on_existing="append")

    for deck in _load_expansion_decks():
        upsert_deck(connection, deck, on_existing="append")


def _load_expansion_decks() -> list[dict[str, Any]]:
    decks: list[dict[str, Any]] = []
    for path in sorted(DATA_DIR.glob(DECK_EXPANSION_PATTERN)):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise ValueError(f"{path.name} must contain a list of deck payloads")
        if not all(isinstance(deck, dict) for deck in payload):
            raise ValueError(f"Each deck expansion payload in {path.name} must be an object")
        decks.extend(payload)
    return decks


def upsert_deck(
    connection: sqlite3.Connection,
    deck: dict[str, Any],
    *,
    on_existing: Literal["append", "replace", "fail"] = "append",
) -> DeckWriteResult:
    normalized_deck = _normalize_deck_payload(deck)
    deck_row = connection.execute(
        "SELECT id FROM decks WHERE slug = ?",
        (normalized_deck["slug"],),
    ).fetchone()

    created_deck = deck_row is None
    deleted_cards = 0
    if created_deck:
        cursor = connection.execute(
            """
            INSERT INTO decks (slug, title, description, language_from, language_to)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                normalized_deck["slug"],
                normalized_deck["title"],
                normalized_deck["description"],
                normalized_deck["language_from"],
                normalized_deck["language_to"],
            ),
        )
        deck_id = cursor.lastrowid
    else:
        if on_existing == "fail":
            raise ValueError(f"Deck with slug '{normalized_deck['slug']}' already exists")

        deck_id = deck_row["id"]
        connection.execute(
            """
            UPDATE decks
            SET title = ?, description = ?, language_from = ?, language_to = ?
            WHERE id = ?
            """,
            (
                normalized_deck["title"],
                normalized_deck["description"],
                normalized_deck["language_from"],
                normalized_deck["language_to"],
                deck_id,
            ),
        )
        if on_existing == "replace":
            delete_cursor = connection.execute("DELETE FROM cards WHERE deck_id = ?", (deck_id,))
            deleted_cards = delete_cursor.rowcount if delete_cursor.rowcount >= 0 else 0

    inserted_cards = 0
    updated_cards = 0
    seen_pairs: set[tuple[str, str]] = set()

    for card in normalized_deck["cards"]:
        pair = (card["spanish"].casefold(), card["english"].casefold())
        if pair in seen_pairs:
            raise ValueError(
                f"Deck '{normalized_deck['slug']}' contains duplicate card pair: {card['spanish']} -> {card['english']}"
            )
        seen_pairs.add(pair)

        serialized_translations = json.dumps(card["main_translations_es"], ensure_ascii=False)
        serialized_collocations = json.dumps(card["collocations"], ensure_ascii=False)
        existing_card = connection.execute(
            """
            SELECT id
            FROM cards
            WHERE deck_id = ? AND spanish_text = ? AND english_text = ?
            """,
            (deck_id, card["spanish"], card["english"]),
        ).fetchone()

        parameters = (
            card["spanish"],
            card["english"],
            card.get("part_of_speech"),
            card.get("definition_en"),
            serialized_translations,
            serialized_collocations,
            card.get("example_sentence"),
            card.get("example_es"),
            card.get("example_en"),
        )

        if existing_card is None:
            connection.execute(
                """
                INSERT INTO cards (
                    deck_id,
                    spanish_text,
                    english_text,
                    part_of_speech,
                    definition_en,
                    main_translations_es,
                    collocations,
                    example_sentence,
                    example_es,
                    example_en
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (deck_id, *parameters),
            )
            inserted_cards += 1
            continue

        connection.execute(
            """
            UPDATE cards
            SET
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
                card.get("part_of_speech"),
                card.get("definition_en"),
                serialized_translations,
                serialized_collocations,
                card.get("example_sentence"),
                card.get("example_es"),
                card.get("example_en"),
                existing_card["id"],
            ),
        )
        updated_cards += 1

    return DeckWriteResult(
        deck_id=deck_id,
        created_deck=created_deck,
        inserted_cards=inserted_cards,
        updated_cards=updated_cards,
        deleted_cards=deleted_cards,
        total_cards=len(normalized_deck["cards"]),
    )


def _normalize_deck_payload(deck: dict[str, Any]) -> dict[str, Any]:
    slug = _require_text(deck.get("slug"), "deck.slug")
    title = _require_text(deck.get("title"), "deck.title")
    description = _require_text(deck.get("description"), "deck.description")
    cards = deck.get("cards")
    if not isinstance(cards, list) or not cards:
        raise ValueError("deck.cards must be a non-empty list")

    return {
        "slug": slug,
        "title": title,
        "description": description,
        "language_from": _optional_text(deck.get("language_from")) or DEFAULT_LANGUAGE_FROM,
        "language_to": _optional_text(deck.get("language_to")) or DEFAULT_LANGUAGE_TO,
        "cards": [_normalize_card_payload(card) for card in cards],
    }


def _normalize_card_payload(card: Any) -> dict[str, Any]:
    if not isinstance(card, dict):
        raise ValueError("Each card must be an object")

    spanish = _require_text(card.get("spanish") or card.get("prompt_es"), "card.spanish")
    english = _require_text(card.get("english") or card.get("answer_en"), "card.english")

    return {
        "spanish": spanish,
        "english": english,
        "part_of_speech": _optional_text(card.get("part_of_speech")),
        "definition_en": _optional_text(card.get("definition_en")),
        "main_translations_es": _normalize_text_list(card.get("main_translations_es")),
        "collocations": _normalize_text_list(card.get("collocations")),
        "example_sentence": _optional_text(card.get("example_sentence")),
        "example_es": _optional_text(card.get("example_es")),
        "example_en": _optional_text(card.get("example_en")),
    }


def _require_text(value: Any, field_name: str) -> str:
    normalized = _optional_text(value)
    if normalized is None:
        raise ValueError(f"{field_name} must be a non-empty string")
    return normalized


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Expected a string value")
    normalized = value.strip()
    return normalized or None


def _normalize_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Expected a list of strings")

    normalized_items: list[str] = []
    seen_items: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise ValueError("Expected a list of strings")
        normalized_item = item.strip()
        if not normalized_item:
            continue
        key = normalized_item.casefold()
        if key in seen_items:
            continue
        seen_items.add(key)
        normalized_items.append(normalized_item)
    return normalized_items


def _migrate_cards_table(connection: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(cards)").fetchall()
    }
    migrations = {
        "part_of_speech": "ALTER TABLE cards ADD COLUMN part_of_speech TEXT",
        "definition_en": "ALTER TABLE cards ADD COLUMN definition_en TEXT",
        "main_translations_es": "ALTER TABLE cards ADD COLUMN main_translations_es TEXT",
        "collocations": "ALTER TABLE cards ADD COLUMN collocations TEXT",
        "example_sentence": "ALTER TABLE cards ADD COLUMN example_sentence TEXT",
        "example_es": "ALTER TABLE cards ADD COLUMN example_es TEXT",
        "example_en": "ALTER TABLE cards ADD COLUMN example_en TEXT",
    }
    for column_name, statement in migrations.items():
        if column_name not in columns:
            connection.execute(statement)
