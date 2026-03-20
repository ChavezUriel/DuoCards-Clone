from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException

from app.db import initialize_database

from .schemas import GenerateBatchResponse, GenerateDeckRequest, GenerateDeckResponse, SpecFileRequest, SpecValidationResponse
from .service import DeckGeneratorService, OllamaError, SpecError

app = FastAPI(title="DuoCards Generator API", version="0.1.0")

service = DeckGeneratorService()
logger = logging.getLogger("generator_app.api")


def _configure_logging() -> None:
    root_logger = logging.getLogger()
    if not root_logger.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        )
    logger.setLevel(logging.INFO)


@app.on_event("startup")
def startup_event() -> None:
    _configure_logging()
    logger.info("Generator API startup: initializing database")
    initialize_database()
    logger.info("Generator API startup complete")


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/specs")
def list_specs() -> list[dict[str, str]]:
    logger.info("Listing available generator specs")
    return [spec.model_dump(mode="json") for spec in service.list_specs()]


@app.post("/specs/validate", response_model=SpecValidationResponse)
def validate_spec(payload: SpecFileRequest) -> SpecValidationResponse:
    logger.info("Validating spec file: spec_path=%s slug=%s", payload.spec_path, payload.slug)
    try:
        specs = service.load_specs(payload.spec_path)
        selected_spec = service.load_spec(payload.spec_path, payload.slug) if payload.slug else None
    except SpecError as exc:
        logger.warning("Spec validation failed: spec_path=%s slug=%s error=%s", payload.spec_path, payload.slug, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    logger.info("Spec validation succeeded: spec_path=%s deck_count=%s", payload.spec_path, len(specs))
    return SpecValidationResponse(specs=specs, selected_spec=selected_spec)


@app.post("/decks/preview")
def preview_deck(payload: GenerateDeckRequest) -> dict[str, object]:
    logger.info(
        "Preview request started: spec_path=%s slug=%s max_repair_attempts=%s",
        payload.spec_path,
        payload.slug,
        payload.max_repair_attempts,
    )
    try:
        preview = service.preview_deck(payload.spec_path, payload.slug, max_repair_attempts=payload.max_repair_attempts)
    except SpecError as exc:
        logger.warning("Preview request failed validation: spec_path=%s slug=%s error=%s", payload.spec_path, payload.slug, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OllamaError as exc:
        logger.error("Preview request failed during Ollama call: spec_path=%s slug=%s error=%s", payload.spec_path, payload.slug, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    logger.info(
        "Preview request completed: spec_path=%s slug=%s cards=%s warnings=%s rejected=%s",
        payload.spec_path,
        preview.spec.slug,
        len(preview.cards),
        len(preview.warnings),
        len(preview.rejected_cards),
    )
    return preview.model_dump(mode="json")


@app.post("/decks/generate", response_model=GenerateDeckResponse)
def generate_deck(payload: GenerateDeckRequest) -> GenerateDeckResponse:
    logger.info(
        "Generate request started: spec_path=%s slug=%s max_repair_attempts=%s",
        payload.spec_path,
        payload.slug,
        payload.max_repair_attempts,
    )
    try:
        result = service.generate_and_insert(payload.spec_path, payload.slug, max_repair_attempts=payload.max_repair_attempts)
    except SpecError as exc:
        logger.warning("Generate request failed validation: spec_path=%s slug=%s error=%s", payload.spec_path, payload.slug, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OllamaError as exc:
        logger.error("Generate request failed during Ollama call: spec_path=%s slug=%s error=%s", payload.spec_path, payload.slug, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        logger.warning("Generate request hit deck conflict: spec_path=%s slug=%s error=%s", payload.spec_path, payload.slug, exc)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    logger.info(
        "Generate request completed: spec_path=%s slug=%s deck_id=%s inserted=%s updated=%s deleted=%s warnings=%s rejected=%s",
        payload.spec_path,
        result["spec"].slug,
        result["deck_id"],
        result["inserted_cards"],
        result["updated_cards"],
        result["deleted_cards"],
        len(result["warnings"]),
        len(result["rejected_cards"]),
    )
    return GenerateDeckResponse(**result)


@app.post("/decks/generate-batch", response_model=GenerateBatchResponse)
def generate_deck_batch(payload: GenerateDeckRequest) -> GenerateBatchResponse:
    logger.info(
        "Batch generate request started: spec_path=%s max_repair_attempts=%s",
        payload.spec_path,
        payload.max_repair_attempts,
    )
    try:
        results = service.generate_all_and_insert(payload.spec_path, max_repair_attempts=payload.max_repair_attempts)
    except SpecError as exc:
        logger.warning("Batch generate request failed validation: spec_path=%s error=%s", payload.spec_path, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OllamaError as exc:
        logger.error("Batch generate request failed during Ollama call: spec_path=%s error=%s", payload.spec_path, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        logger.warning("Batch generate request hit deck conflict: spec_path=%s error=%s", payload.spec_path, exc)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    logger.info("Batch generate request completed: spec_path=%s deck_count=%s", payload.spec_path, len(results))
    return GenerateBatchResponse(results=results)