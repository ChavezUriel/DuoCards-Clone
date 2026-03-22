from __future__ import annotations

import gc
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app.db as db_module
import app.practice as practice_module
from app.main import app
from fastapi.testclient import TestClient


class SmartPracticeApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.original_data_dir = db_module.DATA_DIR
        self.original_database_path = db_module.DATABASE_PATH
        db_module.DATA_DIR = self.temp_path
        db_module.DATABASE_PATH = self.temp_path / "test.db"
        db_module.initialize_database()
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        db_module.DATA_DIR = self.original_data_dir
        db_module.DATABASE_PATH = self.original_database_path
        gc.collect()
        try:
            self.temp_dir.cleanup()
        except PermissionError:
            pass

    def test_new_material_session_requires_two_known_answers_to_finish_card(self) -> None:
        first_response = self.client.post(
            "/api/practice/sessions",
            json={
                "settings": {
                    "new_block_size": 5,
                    "review_batch_size": 20,
                    "interleaving_intensity": "high",
                    "focus_mode": "new_material",
                }
            },
        )

        self.assertEqual(first_response.status_code, 200)
        session = first_response.json()
        session_id = session["summary"]["session_id"]
        first_card_id = session["current_card"]["card_id"]

        second_response = self.client.post(
            f"/api/practice/sessions/{session_id}/reviews",
            json={"card_id": first_card_id, "result": "known"},
        )

        self.assertEqual(second_response.status_code, 200)
        second_session = second_response.json()["session"]
        self.assertEqual(second_session["summary"]["mode"], "new_material")
        self.assertEqual(second_session["summary"]["completed_cards"], 0)
        self.assertNotEqual(second_session["current_card"]["card_id"], first_card_id)

    def test_review_session_requeues_unknown_cards_and_keeps_section_metadata(self) -> None:
        self._initially_master_cards(card_limit=15)
        response = self.client.post(
            "/api/practice/sessions",
            json={
                "settings": {
                    "new_block_size": 5,
                    "review_batch_size": 20,
                    "interleaving_intensity": "high",
                    "focus_mode": "review",
                }
            },
        )

        self.assertEqual(response.status_code, 200)
        session = response.json()
        self.assertEqual(session["summary"]["mode"], "review")
        self.assertEqual(session["summary"]["total_cards"], 15)
        self.assertTrue(session["current_card"]["section_name"])

        session_id = session["summary"]["session_id"]
        first_card_id = session["current_card"]["card_id"]
        next_response = self.client.post(
            f"/api/practice/sessions/{session_id}/reviews",
            json={"card_id": first_card_id, "result": "unknown"},
        )

        self.assertEqual(next_response.status_code, 200)
        next_session = next_response.json()["session"]
        self.assertEqual(next_session["summary"]["remaining_cards"], 15)
        self.assertNotEqual(next_session["current_card"]["card_id"], first_card_id)

    def test_new_material_session_uses_randomized_queue_order(self) -> None:
        def reverse_sample(rows: list[object], k: int) -> list[object]:
            return list(rows)[::-1][:k]

        with patch.object(practice_module.random, "sample", side_effect=reverse_sample) as mocked_sample:
            response = self.client.post(
                "/api/practice/sessions",
                json={
                    "settings": {
                        "new_block_size": 5,
                        "review_batch_size": 20,
                        "interleaving_intensity": "high",
                        "focus_mode": "new_material",
                    }
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["current_card"]["card_id"], 15)
        mocked_sample.assert_called_once()

        with db_module.get_connection() as connection:
            queued_card_ids = [
                row["card_id"]
                for row in connection.execute(
                    "SELECT card_id FROM practice_session_cards WHERE session_id = ? ORDER BY queue_position ASC",
                    (payload["summary"]["session_id"],),
                ).fetchall()
            ]

        self.assertEqual(queued_card_ids, [15, 14, 13, 12, 11])

    def test_review_session_uses_randomized_queue_order(self) -> None:
        self._initially_master_cards(card_limit=15)

        def reverse_sample(rows: list[object], k: int) -> list[object]:
            return list(rows)[::-1][:k]

        with patch.object(practice_module.random, "sample", side_effect=reverse_sample) as mocked_sample:
            response = self.client.post(
                "/api/practice/sessions",
                json={
                    "settings": {
                        "new_block_size": 5,
                        "review_batch_size": 20,
                        "interleaving_intensity": "low",
                        "focus_mode": "review",
                    }
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["summary"]["mode"], "review")
        self.assertEqual(payload["current_card"]["card_id"], 15)
        mocked_sample.assert_called_once()

        with db_module.get_connection() as connection:
            queued_card_ids = [
                row["card_id"]
                for row in connection.execute(
                    "SELECT card_id FROM practice_session_cards WHERE session_id = ? ORDER BY queue_position ASC",
                    (payload["summary"]["session_id"],),
                ).fetchall()
            ]

        self.assertEqual(queued_card_ids, [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])

    def test_deck_preview_returns_full_card_list(self) -> None:
        response = self.client.get("/api/decks/1/preview")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["deck_id"], 1)
        self.assertEqual(payload["deck_title"], "English Basics")
        self.assertEqual(payload["total_cards"], 5)
        self.assertEqual(len(payload["cards"]), 5)
        self.assertEqual(payload["cards"][0]["prompt_es"], "Hola")
        self.assertIn("answer_en", payload["cards"][0])
        self.assertIn("part_of_speech", payload["cards"][0])
        self.assertIn("main_translations_es", payload["cards"][0])

    def test_disabling_card_hides_it_from_deck_surfaces(self) -> None:
        disable_response = self.client.patch(
            "/api/cards/1/visibility",
            json={"is_enabled": False},
        )

        self.assertEqual(disable_response.status_code, 200)
        self.assertFalse(disable_response.json()["is_enabled"])

        preview_response = self.client.get("/api/decks/1/preview")
        preview_payload = preview_response.json()
        self.assertEqual(preview_response.status_code, 200)
        self.assertEqual(preview_payload["total_cards"], 5)
        self.assertEqual([card["card_id"] for card in preview_payload["cards"]], [1, 2, 3, 4, 5])
        self.assertFalse(preview_payload["cards"][0]["is_enabled"])

        decks_response = self.client.get("/api/decks")
        self.assertEqual(decks_response.status_code, 200)
        self.assertEqual(decks_response.json()[0]["total_cards"], 4)

        review_response = self.client.get("/api/decks/1/review")
        self.assertEqual(review_response.status_code, 200)
        self.assertNotEqual(review_response.json()["card_id"], 1)

    def test_disabling_card_removes_it_from_new_practice_sessions(self) -> None:
        disable_response = self.client.patch(
            "/api/cards/1/visibility",
            json={"is_enabled": False},
        )
        self.assertEqual(disable_response.status_code, 200)

        session_response = self.client.post(
            "/api/practice/sessions",
            json={
                "settings": {
                    "new_block_size": 5,
                    "review_batch_size": 20,
                    "interleaving_intensity": "high",
                    "focus_mode": "new_material",
                }
            },
        )

        self.assertEqual(session_response.status_code, 200)
        payload = session_response.json()
        self.assertNotEqual(payload["current_card"]["card_id"], 1)

        with db_module.get_connection() as connection:
            queued_card_ids = [
                row["card_id"]
                for row in connection.execute(
                    "SELECT card_id FROM practice_session_cards WHERE session_id = ? ORDER BY queue_position ASC",
                    (payload["summary"]["session_id"],),
                ).fetchall()
            ]

        self.assertNotIn(1, queued_card_ids)

    def test_disabled_card_can_be_reenabled(self) -> None:
        self.client.patch("/api/cards/1/visibility", json={"is_enabled": False})

        enable_response = self.client.patch(
            "/api/cards/1/visibility",
            json={"is_enabled": True},
        )

        self.assertEqual(enable_response.status_code, 200)
        self.assertTrue(enable_response.json()["is_enabled"])

        preview_response = self.client.get("/api/decks/1/preview")
        preview_payload = preview_response.json()
        self.assertTrue(preview_payload["cards"][0]["is_enabled"])

        decks_response = self.client.get("/api/decks")
        self.assertEqual(decks_response.json()[0]["total_cards"], 5)

    def test_decks_endpoint_exposes_smart_practice_toggle_state(self) -> None:
        response = self.client.get("/api/decks")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload[0]["is_enabled_in_smart_practice"])

    def test_disabling_deck_excludes_it_from_new_smart_practice_sessions(self) -> None:
        disable_response = self.client.patch(
            "/api/decks/1/smart-practice-inclusion",
            json={"is_enabled_in_smart_practice": False},
        )

        self.assertEqual(disable_response.status_code, 200)
        self.assertFalse(disable_response.json()["is_enabled_in_smart_practice"])

        decks_response = self.client.get("/api/decks")
        self.assertEqual(decks_response.status_code, 200)
        self.assertFalse(decks_response.json()[0]["is_enabled_in_smart_practice"])

        session_response = self.client.post(
            "/api/practice/sessions",
            json={
                "settings": {
                    "new_block_size": 5,
                    "review_batch_size": 20,
                    "interleaving_intensity": "high",
                    "focus_mode": "new_material",
                }
            },
        )

        self.assertEqual(session_response.status_code, 200)

        with db_module.get_connection() as connection:
            queued_deck_ids = {
                row["deck_id"]
                for row in connection.execute(
                    """
                    SELECT DISTINCT c.deck_id
                    FROM practice_session_cards psc
                    JOIN cards c ON c.id = psc.card_id
                    WHERE psc.session_id = ?
                    """,
                    (session_response.json()["summary"]["session_id"],),
                ).fetchall()
            }

        self.assertNotIn(1, queued_deck_ids)

    def test_disabling_deck_removes_pending_cards_from_active_session(self) -> None:
        session_response = self.client.post(
            "/api/practice/sessions",
            json={
                "settings": {
                    "new_block_size": 8,
                    "review_batch_size": 20,
                    "interleaving_intensity": "high",
                    "focus_mode": "new_material",
                }
            },
        )

        self.assertEqual(session_response.status_code, 200)
        session_id = session_response.json()["summary"]["session_id"]

        disable_response = self.client.patch(
            "/api/decks/1/smart-practice-inclusion",
            json={"is_enabled_in_smart_practice": False},
        )

        self.assertEqual(disable_response.status_code, 200)

        with db_module.get_connection() as connection:
            remaining_rows = connection.execute(
                """
                SELECT c.deck_id
                FROM practice_session_cards psc
                JOIN cards c ON c.id = psc.card_id
                WHERE psc.session_id = ? AND psc.status = 'pending'
                """,
                (session_id,),
            ).fetchall()

        self.assertTrue(remaining_rows)
        self.assertTrue(all(row["deck_id"] != 1 for row in remaining_rows))

    def test_disabling_only_available_deck_completes_active_session(self) -> None:
        self.client.patch(
            "/api/decks/2/smart-practice-inclusion",
            json={"is_enabled_in_smart_practice": False},
        )
        self.client.patch(
            "/api/decks/3/smart-practice-inclusion",
            json={"is_enabled_in_smart_practice": False},
        )

        session_response = self.client.post(
            "/api/practice/sessions",
            json={
                "settings": {
                    "new_block_size": 5,
                    "review_batch_size": 20,
                    "interleaving_intensity": "high",
                    "focus_mode": "new_material",
                }
            },
        )

        self.assertEqual(session_response.status_code, 200)
        session_id = session_response.json()["summary"]["session_id"]

        disable_response = self.client.patch(
            "/api/decks/1/smart-practice-inclusion",
            json={"is_enabled_in_smart_practice": False},
        )

        self.assertEqual(disable_response.status_code, 200)

        snapshot_response = self.client.get(f"/api/practice/sessions/{session_id}")
        self.assertEqual(snapshot_response.status_code, 200)
        snapshot = snapshot_response.json()
        self.assertEqual(snapshot["summary"]["status"], "completed")
        self.assertIsNone(snapshot["current_card"])

    def test_disabled_deck_can_be_reenabled_for_future_sessions(self) -> None:
        self.client.patch(
            "/api/decks/1/smart-practice-inclusion",
            json={"is_enabled_in_smart_practice": False},
        )

        enable_response = self.client.patch(
            "/api/decks/1/smart-practice-inclusion",
            json={"is_enabled_in_smart_practice": True},
        )

        self.assertEqual(enable_response.status_code, 200)
        self.assertTrue(enable_response.json()["is_enabled_in_smart_practice"])

        with patch.object(practice_module.random, "sample", side_effect=lambda rows, k: list(rows)[:k]):
            session_response = self.client.post(
                "/api/practice/sessions",
                json={
                    "settings": {
                        "new_block_size": 5,
                        "review_batch_size": 20,
                        "interleaving_intensity": "high",
                        "focus_mode": "new_material",
                    }
                },
            )

        self.assertEqual(session_response.status_code, 200)

        with db_module.get_connection() as connection:
            queued_deck_ids = {
                row["deck_id"]
                for row in connection.execute(
                    """
                    SELECT DISTINCT c.deck_id
                    FROM practice_session_cards psc
                    JOIN cards c ON c.id = psc.card_id
                    WHERE psc.session_id = ?
                    """,
                    (session_response.json()["summary"]["session_id"],),
                ).fetchall()
            }

        self.assertIn(1, queued_deck_ids)

    def test_card_update_persists_edited_metadata(self) -> None:
        response = self.client.patch(
            "/api/cards/1",
            json={
                "prompt_es": "Hola a todos",
                "answer_en": "Hello everyone",
                "section_name": "Greetings",
                "part_of_speech": "expression",
                "definition_en": "A greeting addressed to a group.",
                "main_translations_es": ["hola a todos", "buenas a todos"],
                "collocations": ["say hello everyone", "hello everyone"],
                "example_sentence": "Hello everyone, welcome to class.",
                "example_es": "Hola a todos, bienvenidos a clase.",
                "example_en": "Hello everyone, welcome to class.",
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["prompt_es"], "Hola a todos")
        self.assertEqual(payload["answer_en"], "Hello everyone")
        self.assertEqual(payload["section_name"], "Greetings")
        self.assertEqual(payload["main_translations_es"], ["hola a todos", "buenas a todos"])

        preview_response = self.client.get("/api/decks/1/preview")
        preview_payload = preview_response.json()
        updated_card = next(card for card in preview_payload["cards"] if card["card_id"] == 1)
        self.assertEqual(updated_card["prompt_es"], "Hola a todos")
        self.assertEqual(updated_card["definition_en"], "A greeting addressed to a group.")

    def _initially_master_cards(self, *, card_limit: int) -> None:
        with db_module.get_connection() as connection:
            card_rows = connection.execute("SELECT id FROM cards ORDER BY id LIMIT ?", (card_limit,)).fetchall()
            for row in card_rows:
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
                    VALUES (?, 2, 0, 2, 'known', '2026-03-20T00:00:00+00:00', '2026-03-20T00:00:00+00:00')
                    ON CONFLICT(card_id) DO UPDATE SET
                        known_count = excluded.known_count,
                        unknown_count = excluded.unknown_count,
                        known_streak = excluded.known_streak,
                        last_result = excluded.last_result,
                        last_reviewed_at = excluded.last_reviewed_at,
                        initial_mastered_at = excluded.initial_mastered_at
                    """,
                    (row["id"],),
                )
            connection.commit()


if __name__ == "__main__":
    unittest.main()