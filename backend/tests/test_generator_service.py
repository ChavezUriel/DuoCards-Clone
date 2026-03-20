from __future__ import annotations

import gc
import tempfile
import unittest
from pathlib import Path

import yaml

import app.db as db_module
from app.main import list_decks
from generator_app.service import DeckGeneratorService, OllamaError, SpecError


class ScriptedOllamaClient:
    def __init__(self, steps: list[tuple[str, dict | Exception]]) -> None:
        self.steps = list(steps)
        self.calls: list[str] = []

    def chat_json(self, *, model: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> dict:
        self.calls.append(model)
        if not self.steps:
            raise AssertionError(f"Unexpected Ollama call for model {model}")

        expected_model, outcome = self.steps.pop(0)
        if expected_model != model:
            raise AssertionError(f"Expected model {expected_model}, received {model}")

        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def build_valid_card(index: int, prefix: str) -> dict[str, object]:
    return {
        "spanish": f"{prefix} es {index}",
        "english": f"{prefix} en {index}",
        "part_of_speech": "expression",
        "definition_en": f"Definition {index}",
        "main_translations_es": [f"{prefix} es {index}", f"alternativa {index}"],
        "collocations": [f"{prefix} collocation {index}a", f"{prefix} collocation {index}b"],
        "example_sentence": f"This is {prefix} example {index}.",
        "example_es": f"Este es {prefix} ejemplo {index}.",
        "example_en": f"This is {prefix} example {index}.",
    }


def build_valid_batch(prefix: str, count: int = 4) -> dict[str, object]:
    return {"cards": [build_valid_card(index, prefix) for index in range(1, count + 1)]}


def build_invalid_station_batch() -> dict[str, object]:
    return {
        "cards": [
            {
                "spanish": "Billete",
                "english": "Ticket",
                "part_of_speech": "noun",
                "definition_en": "A document for travel.",
                "main_translations_es": ["billete"],
                "collocations": ["buy a ticket"],
                "example_sentence": "¿Dónde está la estación?",
                "example_es": "¿Dónde está la estación?",
                "example_en": "¿Dónde está la estación?",
            },
            {
                "spanish": "Andén",
                "english": "Platform",
                "part_of_speech": "noun",
                "definition_en": "The place where you wait for the train.",
                "main_translations_es": ["andén"],
                "collocations": ["train platform"],
                "example_sentence": "¿En qué andén espero?",
                "example_es": "¿En qué andén espero?",
                "example_en": "¿En qué andén espero?",
            },
            {
                "spanish": "Estación",
                "english": "Station",
                "part_of_speech": "noun",
                "definition_en": "A place where trains arrive and leave.",
                "main_translations_es": ["estación"],
                "collocations": ["rail station"],
                "example_sentence": "¿Dónde está la estación?",
                "example_es": "¿Dónde está la estación?",
                "example_en": "¿Dónde está la estación?",
            },
            {
                "spanish": "¿Dónde espero?",
                "english": "Where do I wait?",
                "part_of_speech": "question",
                "definition_en": "Ask where to wait.",
                "main_translations_es": ["¿dónde espero?"],
                "collocations": ["wait here"],
                "example_sentence": "¿Dónde espero el tren?",
                "example_es": "¿Dónde espero el tren?",
                "example_en": "¿Dónde espero el tren?",
            },
        ]
    }


class DeckGeneratorServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.original_data_dir = db_module.DATA_DIR
        self.original_database_path = db_module.DATABASE_PATH
        db_module.DATA_DIR = self.temp_path
        db_module.DATABASE_PATH = self.temp_path / "test.db"

    def tearDown(self) -> None:
        db_module.DATA_DIR = self.original_data_dir
        db_module.DATABASE_PATH = self.original_database_path
        gc.collect()
        try:
            self.temp_dir.cleanup()
        except PermissionError:
            pass

    def write_spec(self, file_name: str, payload: dict[str, object]) -> str:
        spec_path = self.temp_path / file_name
        spec_path.write_text(yaml.safe_dump(payload, sort_keys=False, allow_unicode=True), encoding="utf-8")
        return str(spec_path)

    def test_generate_all_and_insert_supports_batch_specs(self) -> None:
        spec_path = self.write_spec(
            "batch.yaml",
            {
                "decks": [
                    {
                        "slug": "batch-deck-one",
                        "title": "Batch One",
                        "description": "First batch deck.",
                        "topic": "cafe",
                        "difficulty": "beginner",
                        "desired_card_count": 4,
                        "batch_size": 4,
                        "model": "qwen3.5:latest",
                        "fallback_models": ["gemma3:4b"],
                        "overwrite_mode": "replace",
                        "sections": [
                            {
                                "name": "Cafe",
                                "communicative_goal": "Order at a cafe.",
                                "lexical_focus": ["coffee", "bill"],
                                "target_card_count": 4,
                            }
                        ],
                    },
                    {
                        "slug": "batch-deck-two",
                        "title": "Batch Two",
                        "description": "Second batch deck.",
                        "topic": "station",
                        "difficulty": "beginner",
                        "desired_card_count": 4,
                        "batch_size": 4,
                        "model": "qwen3.5:latest",
                        "fallback_models": ["gemma3:4b"],
                        "overwrite_mode": "replace",
                        "sections": [
                            {
                                "name": "Station",
                                "communicative_goal": "Find the right train.",
                                "lexical_focus": ["ticket", "platform"],
                                "target_card_count": 4,
                            }
                        ],
                    },
                ]
            },
        )
        client = ScriptedOllamaClient(
            [
                ("qwen3.5:latest", build_valid_batch("batch-one")),
                ("qwen3.5:latest", build_valid_batch("batch-two")),
            ]
        )
        service = DeckGeneratorService(ollama_client=client)

        results = service.generate_all_and_insert(spec_path, max_repair_attempts=1)

        self.assertEqual(len(results), 2)
        self.assertEqual([result.spec.slug for result in results], ["batch-deck-one", "batch-deck-two"])
        generated_slugs = {deck.slug for deck in list_decks()}
        self.assertIn("batch-deck-one", generated_slugs)
        self.assertIn("batch-deck-two", generated_slugs)

    def test_generate_and_insert_rejects_undersized_output(self) -> None:
        spec_path = self.write_spec(
            "undersized.yaml",
            {
                "deck": {
                    "slug": "undersized-deck",
                    "title": "Undersized",
                    "description": "Should fail when not enough cards are produced.",
                    "topic": "cafe",
                    "difficulty": "beginner",
                    "desired_card_count": 4,
                    "batch_size": 4,
                    "model": "qwen3.5:latest",
                    "fallback_models": [],
                    "overwrite_mode": "replace",
                    "sections": [
                        {
                            "name": "Cafe",
                            "communicative_goal": "Order politely.",
                            "lexical_focus": ["coffee"],
                            "target_card_count": 4,
                        }
                    ],
                }
            },
        )
        partial_batch = {"cards": [build_valid_card(1, "partial"), build_valid_card(2, "partial")]}
        client = ScriptedOllamaClient(
            [
                ("qwen3.5:latest", partial_batch),
                ("qwen3.5:latest", partial_batch),
                ("qwen3.5:latest", partial_batch),
            ]
        )
        service = DeckGeneratorService(ollama_client=client)

        with self.assertRaises(SpecError):
            service.generate_and_insert(spec_path, max_repair_attempts=0)

    def test_generate_and_insert_respects_fail_overwrite_mode(self) -> None:
        spec_path = self.write_spec(
            "conflict.yaml",
            {
                "deck": {
                    "slug": "conflict-deck",
                    "title": "Conflict Deck",
                    "description": "Should fail on second insert.",
                    "topic": "cafe",
                    "difficulty": "beginner",
                    "desired_card_count": 4,
                    "batch_size": 4,
                    "model": "qwen3.5:latest",
                    "fallback_models": [],
                    "overwrite_mode": "fail",
                    "sections": [
                        {
                            "name": "Cafe",
                            "communicative_goal": "Order politely.",
                            "lexical_focus": ["coffee"],
                            "target_card_count": 4,
                        }
                    ],
                }
            },
        )
        client = ScriptedOllamaClient(
            [
                ("qwen3.5:latest", build_valid_batch("conflict-one")),
                ("qwen3.5:latest", build_valid_batch("conflict-two")),
            ]
        )
        service = DeckGeneratorService(ollama_client=client)

        first_result = service.generate_and_insert(spec_path, max_repair_attempts=0)

        self.assertTrue(first_result["created_deck"])
        with self.assertRaises(ValueError):
            service.generate_and_insert(spec_path, max_repair_attempts=0)

    def test_repair_prefers_last_successful_fallback_model(self) -> None:
        spec_path = self.write_spec(
            "repair.yaml",
            {
                "deck": {
                    "slug": "repair-deck",
                    "title": "Repair Deck",
                    "description": "Exercise fallback repair ordering.",
                    "topic": "station",
                    "difficulty": "beginner",
                    "desired_card_count": 4,
                    "batch_size": 4,
                    "model": "qwen3.5:latest",
                    "fallback_models": ["gemma3:4b", "llama3.1:latest"],
                    "overwrite_mode": "replace",
                    "sections": [
                        {
                            "name": "Station",
                            "communicative_goal": "Find the right train.",
                            "lexical_focus": ["ticket", "platform"],
                            "target_card_count": 4,
                        }
                    ],
                }
            },
        )
        client = ScriptedOllamaClient(
            [
                ("qwen3.5:latest", OllamaError("empty response")),
                ("gemma3:4b", build_invalid_station_batch()),
                ("gemma3:4b", build_valid_batch("repair")),
            ]
        )
        service = DeckGeneratorService(ollama_client=client)

        result = service.generate_and_insert(spec_path, max_repair_attempts=1)

        self.assertEqual(client.calls, ["qwen3.5:latest", "gemma3:4b", "gemma3:4b"])
        self.assertEqual(result["total_cards"], 4)
        self.assertTrue(any("fell back from qwen3.5:latest to gemma3:4b" in warning for warning in result["warnings"]))

    def test_generate_and_insert_accepts_flashcards_key(self) -> None:
        spec_path = self.write_spec(
            "flashcards-key.yaml",
            {
                "deck": {
                    "slug": "flashcards-key-deck",
                    "title": "Flashcards Key Deck",
                    "description": "Accept alternate top-level list keys.",
                    "topic": "cafe",
                    "difficulty": "beginner",
                    "desired_card_count": 4,
                    "batch_size": 4,
                    "model": "qwen3.5:latest",
                    "fallback_models": [],
                    "overwrite_mode": "replace",
                    "sections": [
                        {
                            "name": "Cafe",
                            "communicative_goal": "Order politely.",
                            "lexical_focus": ["coffee"],
                            "target_card_count": 4,
                        }
                    ],
                }
            },
        )
        client = ScriptedOllamaClient(
            [("qwen3.5:latest", {"flashcards": build_valid_batch("flashcards")["cards"]})]
        )
        service = DeckGeneratorService(ollama_client=client)

        result = service.generate_and_insert(spec_path, max_repair_attempts=0)

        self.assertEqual(result["total_cards"], 4)
        self.assertEqual(result["inserted_cards"], 4)

    def test_generate_and_insert_accepts_bare_list_payload(self) -> None:
        spec_path = self.write_spec(
            "bare-list.yaml",
            {
                "deck": {
                    "slug": "bare-list-deck",
                    "title": "Bare List Deck",
                    "description": "Accept bare list payloads.",
                    "topic": "cafe",
                    "difficulty": "beginner",
                    "desired_card_count": 4,
                    "batch_size": 4,
                    "model": "qwen3.5:latest",
                    "fallback_models": [],
                    "overwrite_mode": "replace",
                    "sections": [
                        {
                            "name": "Cafe",
                            "communicative_goal": "Order politely.",
                            "lexical_focus": ["coffee"],
                            "target_card_count": 4,
                        }
                    ],
                }
            },
        )
        client = ScriptedOllamaClient(
            [("qwen3.5:latest", build_valid_batch("bare-list")["cards"])]
        )
        service = DeckGeneratorService(ollama_client=client)

        result = service.generate_and_insert(spec_path, max_repair_attempts=0)

        self.assertEqual(result["total_cards"], 4)
        self.assertEqual(result["inserted_cards"], 4)


if __name__ == "__main__":
    unittest.main()