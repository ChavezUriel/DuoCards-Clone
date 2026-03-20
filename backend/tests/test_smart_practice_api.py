from __future__ import annotations

import gc
import tempfile
import unittest
from pathlib import Path

import app.db as db_module
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