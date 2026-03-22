Run the API with:
uvicorn app.main:app --reload --app-dir backend

Run the generator service with:
uvicorn generator_app.main:app --reload --port 8001 --app-dir backend

The generator supports single-deck files with `deck:` and multi-deck files with `decks:`.
