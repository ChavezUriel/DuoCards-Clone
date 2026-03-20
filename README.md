# DuoCards Clone

A small DuoCards-inspired MVP for Spanish speakers learning English.

## Stack

- Frontend: React + Vite
- Backend: FastAPI
- Database: SQLite

## Features in this first version

- Starter English decks seeded automatically in SQLite
- Flashcard review flow with reveal-answer mechanic
- Known / unknown tracking persisted locally
- Per-deck progress summary
- Backend API designed so a future mobile client can reuse it

## Project structure

- `frontend/`: React app
- `backend/`: FastAPI app and SQLite bootstrap

## Run locally

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Generator service

The generator service uses local Ollama and writes directly into the same SQLite database as the main API.

The generator defaults now prefer `qwen3.5:latest`, then `gemma3:4b`, then `llama3.1:latest`. The larger `gpt-oss:20b` model is still supported if you specify it in a spec file.

```powershell
cd backend
pip install -r requirements.txt
uvicorn generator_app.main:app --reload --port 8001
```

With Ollama running locally, you can validate or generate a deck from one of the spec files in `backend/generator_specs/`.

Use `smoke_test_cafe.yaml` for a quick validation pass before trying larger specs.

Use `batch_beginner_bundle.yaml` to validate or generate multiple deck specs from a single file.

Example preview request:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8001/decks/preview -ContentType 'application/json' -Body '{"spec_path":"beginner_travel_food.yaml"}'
```

If a file contains multiple decks, pass a slug when previewing a single one:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8001/decks/preview -ContentType 'application/json' -Body '{"spec_path":"batch_beginner_bundle.yaml","slug":"ai-batch-cafe-basics"}'
```

Example generate-and-insert request:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8001/decks/generate -ContentType 'application/json' -Body '{"spec_path":"beginner_travel_food.yaml"}'
```

Example batch generate request:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8001/decks/generate-batch -ContentType 'application/json' -Body '{"spec_path":"batch_beginner_bundle.yaml"}'
```

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

The frontend expects the API at `http://localhost:8000`.

## API endpoints

- `GET /api/health`
- `GET /api/decks`
- `GET /api/decks/{deck_id}/review`
- `GET /api/decks/{deck_id}/progress`
- `POST /api/reviews`

## Generator endpoints

- `GET /health`
- `GET /specs`
- `POST /specs/validate`
- `POST /decks/preview`
- `POST /decks/generate`
- `POST /decks/generate-batch`
