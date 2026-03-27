# DuoCards Clone

A small DuoCards-inspired MVP for Spanish speakers learning English.

## Stack

- Frontend: React + Vite
- Backend: FastAPI
- Database: SQLite

## Features in this first version

- Starter English decks seeded automatically in SQLite
- Deck market with global home selection
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

The generator service writes directly into the same SQLite database as the main API.

By default it uses local Ollama. You can also use OpenAI models by setting `model_provider: openai` in the spec, choosing an OpenAI model name in `model`, and sending an `api_key` in the request body or setting `OPENAI_API_KEY` in the environment.

The default Ollama model order still prefers `qwen3.5:latest`, then `gemma3:4b`, then `llama3.1:latest`. The larger `gpt-oss:20b` model is still supported if you specify it in a spec file.

```powershell
cd backend
pip install -r requirements.txt
uvicorn generator_app.main:app --reload --port 8001
```

With Ollama running locally, or with an OpenAI API key available, you can validate or generate a deck from one of the spec files in `backend/generator_specs/`.

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

Example OpenAI spec fragment:

```yaml
deck:
	slug: ai-openai-cafe
	title: OpenAI Cafe
	description: Cafe vocabulary generated with OpenAI.
	topic: cafe
	difficulty: beginner
	desired_card_count: 8
	batch_size: 8
	model_provider: openai
	model: gpt-4.1-mini
	fallback_models:
		- gpt-4o-mini
	overwrite_mode: replace
```

Example OpenAI generate request:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8001/decks/generate -ContentType 'application/json' -Body '{"spec_path":"my_openai_spec.yaml","api_key":"YOUR_OPENAI_API_KEY"}'
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
- `GET /api/decks/market`
- `PATCH /api/decks/{deck_id}/home-selection`
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
