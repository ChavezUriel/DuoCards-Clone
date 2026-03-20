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
