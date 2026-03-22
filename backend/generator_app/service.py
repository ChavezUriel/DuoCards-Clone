from __future__ import annotations

from collections import Counter
import json
import logging
import os
from pathlib import Path
import time
from typing import Any
from urllib import error, request

import httpx
import yaml
from pydantic import ValidationError

from app.db import get_connection, initialize_database, upsert_deck

from .schemas import (
    DeckBlueprint,
    DeckBlueprintSection,
    DeckGenerationSpec,
    DeckPreview,
    EnrichDeckRequest,
    GenerateDeckResponse,
    GenerateWordSetResponse,
    GeneratedCard,
    GenerationPhaseSummary,
    RejectedCard,
    SpecFileInfo,
)

BASE_DIR = Path(__file__).resolve().parent.parent
SPEC_DIR = BASE_DIR / "generator_specs"
MODEL_ALIASES = {
    "gpt:oss-20b": "gpt-oss:20b",
}
MODEL_REQUEST_TIMEOUT_SECONDS = 600
OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY"
logger = logging.getLogger("generator_app.service")
WORD_SET_PROMPT_VERSION = "word-set-v1"
ENRICHMENT_PROMPT_VERSION = "enrichment-v1"


class OllamaError(RuntimeError):
    pass


class SpecError(ValueError):
    pass


class ModelClient:
    def __init__(
        self,
        ollama_base_url: str = "http://127.0.0.1:11434",
        openai_base_url: str = "https://api.openai.com/v1",
    ) -> None:
        self.ollama_base_url = ollama_base_url.rstrip("/")
        self.openai_base_url = openai_base_url.rstrip("/")

    def chat_json(
        self,
        *,
        provider: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        if provider == "openai":
            return self._chat_openai(
                model=model,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=temperature,
                api_key=api_key,
            )
        if provider != "ollama":
            raise OllamaError(f"Unsupported model provider '{provider}'")
        return self._chat_ollama(
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
        )

    def _chat_ollama(self, *, model: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> dict[str, Any]:
        resolved_model = MODEL_ALIASES.get(model, model)
        logger.info("Ollama chat request started: model=%s temperature=%s", resolved_model, temperature)
        started_at = time.perf_counter()
        payload = {
            "model": resolved_model,
            "think": False,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": temperature,
            },
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        body = json.dumps(payload).encode("utf-8")
        http_request = request.Request(
            url=f"{self.ollama_base_url}/api/chat",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with request.urlopen(http_request, timeout=MODEL_REQUEST_TIMEOUT_SECONDS) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            logger.warning(
                "Ollama HTTP error: model=%s status=%s elapsed_ms=%s detail=%s",
                resolved_model,
                exc.code,
                _elapsed_ms(started_at),
                detail,
            )
            raise OllamaError(f"Ollama request failed for model '{resolved_model}' with status {exc.code}: {detail}") from exc
        except error.URLError as exc:
            logger.warning(
                "Ollama connection error for model=%s elapsed_ms=%s: %s",
                resolved_model,
                _elapsed_ms(started_at),
                exc,
            )
            raise OllamaError("Unable to reach Ollama at http://127.0.0.1:11434") from exc
        except TimeoutError as exc:
            logger.warning(
                "Ollama timeout: model=%s timeout_seconds=%s elapsed_ms=%s",
                resolved_model,
                MODEL_REQUEST_TIMEOUT_SECONDS,
                _elapsed_ms(started_at),
            )
            raise OllamaError(
                f"Ollama request timed out for model '{resolved_model}' after {MODEL_REQUEST_TIMEOUT_SECONDS} seconds"
            ) from exc

        content = response_payload.get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            logger.warning("Ollama returned empty content: model=%s", resolved_model)
            raise OllamaError("Ollama returned an empty response")

        try:
            parsed = json.loads(_extract_json_text(content))
        except json.JSONDecodeError as exc:
            logger.warning("Ollama returned invalid JSON: model=%s elapsed_ms=%s", resolved_model, _elapsed_ms(started_at))
            raise OllamaError(f"Ollama returned invalid JSON content: {content}") from exc
        logger.info("Ollama chat request completed: model=%s elapsed_ms=%s", resolved_model, _elapsed_ms(started_at))
        return parsed

    def _chat_openai(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        resolved_api_key = api_key or os.getenv(OPENAI_API_KEY_ENV_VAR)
        if not resolved_api_key:
            raise OllamaError(
                "OpenAI API key is required. Provide api_key in the request or set OPENAI_API_KEY in the environment"
            )

        logger.info("OpenAI chat request started: model=%s temperature=%s", model, temperature)
        started_at = time.perf_counter()
        payload = {
            "model": model,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }

        try:
            response = httpx.post(
                f"{self.openai_base_url}/chat/completions",
                json=payload,
                headers={
                    "Authorization": f"Bearer {resolved_api_key}",
                    "Content-Type": "application/json",
                },
                timeout=MODEL_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            response_payload = response.json()
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text
            logger.warning(
                "OpenAI HTTP error: model=%s status=%s elapsed_ms=%s detail=%s",
                model,
                exc.response.status_code,
                _elapsed_ms(started_at),
                detail,
            )
            raise OllamaError(
                f"OpenAI request failed for model '{model}' with status {exc.response.status_code}: {detail}"
            ) from exc
        except httpx.RequestError as exc:
            logger.warning(
                "OpenAI connection error for model=%s elapsed_ms=%s: %s",
                model,
                _elapsed_ms(started_at),
                exc,
            )
            raise OllamaError("Unable to reach the OpenAI API") from exc

        content = _extract_openai_message_content(response_payload)
        if not content.strip():
            logger.warning("OpenAI returned empty content: model=%s", model)
            raise OllamaError("OpenAI returned an empty response")

        try:
            parsed = json.loads(_extract_json_text(content))
        except json.JSONDecodeError as exc:
            logger.warning("OpenAI returned invalid JSON: model=%s elapsed_ms=%s", model, _elapsed_ms(started_at))
            raise OllamaError(f"OpenAI returned invalid JSON content: {content}") from exc
        logger.info("OpenAI chat request completed: model=%s elapsed_ms=%s", model, _elapsed_ms(started_at))
        return parsed


class DeckGeneratorService:
    def __init__(self, ollama_client: ModelClient | None = None) -> None:
        self.ollama_client = ollama_client or ModelClient()

    def list_specs(self) -> list[SpecFileInfo]:
        SPEC_DIR.mkdir(parents=True, exist_ok=True)
        files = [
            path
            for path in SPEC_DIR.iterdir()
            if path.is_file() and path.suffix.lower() in {".json", ".yaml", ".yml"}
        ]
        return [
            SpecFileInfo(name=path.name, path=str(path.relative_to(BASE_DIR).as_posix()))
            for path in sorted(files)
        ]

    def load_specs(self, spec_path: str) -> list[DeckGenerationSpec]:
        resolved_path = _resolve_spec_path(spec_path)
        logger.info("Loading spec file: spec_path=%s resolved_path=%s", spec_path, resolved_path)
        if not resolved_path.exists() or not resolved_path.is_file():
            raise SpecError(f"Spec file not found: {spec_path}")

        if resolved_path.suffix.lower() == ".json":
            payload = json.loads(resolved_path.read_text(encoding="utf-8"))
        else:
            payload = yaml.safe_load(resolved_path.read_text(encoding="utf-8"))

        try:
            specs = [DeckGenerationSpec.model_validate(deck_payload) for deck_payload in _extract_deck_payloads(payload)]
        except ValidationError as exc:
            raise SpecError(str(exc)) from exc
        logger.info("Loaded spec file successfully: spec_path=%s deck_count=%s", spec_path, len(specs))
        return specs

    def load_spec(self, spec_path: str, slug: str | None = None) -> DeckGenerationSpec:
        specs = self.load_specs(spec_path)
        if slug is not None:
            for spec in specs:
                if spec.slug == slug:
                    return spec
            raise SpecError(f"Spec file '{spec_path}' does not contain a deck with slug '{slug}'")
        if len(specs) != 1:
            available_slugs = ", ".join(spec.slug for spec in specs)
            raise SpecError(
                f"Spec file '{spec_path}' contains multiple decks. Specify a slug. Available slugs: {available_slugs}"
            )
        return specs[0]

    def preview_deck(
        self,
        spec_path: str,
        slug: str | None = None,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> DeckPreview:
        spec = self.load_spec(spec_path, slug)
        return self._preview_spec(spec, max_repair_attempts=max_repair_attempts, api_key=api_key)

    def _preview_spec(
        self,
        spec: DeckGenerationSpec,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> DeckPreview:
        logger.info(
            "Preview pipeline started: slug=%s desired_cards=%s batch_size=%s",
            spec.slug,
            spec.desired_card_count,
            spec.batch_size,
        )
        blueprint, blueprint_warnings = self._build_blueprint(spec, api_key=api_key)
        cards, warnings, rejected_cards = self._generate_cards(
            spec,
            blueprint,
            max_repair_attempts=max_repair_attempts,
            api_key=api_key,
        )
        logger.info(
            "Preview pipeline completed: slug=%s cards=%s warnings=%s rejected=%s",
            spec.slug,
            len(cards),
            len(blueprint_warnings) + len(warnings),
            len(rejected_cards),
        )
        return DeckPreview(
            spec=spec,
            blueprint=blueprint,
            cards=cards,
            warnings=blueprint_warnings + warnings,
            rejected_cards=rejected_cards,
        )

    def generate_word_set_and_insert(
        self,
        spec_path: str,
        slug: str | None = None,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        spec = self.load_spec(spec_path, slug)
        return self._generate_word_set_spec_and_insert(spec, max_repair_attempts=max_repair_attempts, api_key=api_key)

    def generate_and_insert(
        self,
        spec_path: str,
        slug: str | None = None,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        spec = self.load_spec(spec_path, slug)
        return self._generate_spec_and_insert(spec, max_repair_attempts=max_repair_attempts, api_key=api_key)

    def _generate_spec_and_insert(
        self,
        spec: DeckGenerationSpec,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        word_set_result = self._generate_word_set_spec_and_insert(
            spec,
            max_repair_attempts=max_repair_attempts,
            api_key=api_key,
        )
        enrich_result = self._enrich_generated_deck(
            deck_id=word_set_result["deck_id"],
            spec=spec,
            max_repair_attempts=max_repair_attempts,
            api_key=api_key,
        )
        return {
            "spec": word_set_result["spec"],
            "blueprint": word_set_result["blueprint"],
            "warnings": [*word_set_result["warnings"], *enrich_result["warnings"]],
            "rejected_cards": [*word_set_result["rejected_cards"], *enrich_result["rejected_cards"]],
            "deck_id": word_set_result["deck_id"],
            "created_deck": word_set_result["created_deck"],
            "inserted_cards": word_set_result["inserted_cards"],
            "updated_cards": word_set_result["updated_cards"],
            "deleted_cards": word_set_result["deleted_cards"],
            "total_cards": word_set_result["total_cards"],
            "phase_summary": enrich_result["phase_summary"],
        }

    def _generate_word_set_spec_and_insert(
        self,
        spec: DeckGenerationSpec,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        preview = self._preview_spec(spec, max_repair_attempts=max_repair_attempts, api_key=api_key)
        if len(preview.cards) < preview.spec.desired_card_count:
            raise SpecError(
                f"Generated {len(preview.cards)} valid cards, below the requested {preview.spec.desired_card_count}"
            )

        initialize_database()
        logger.info(
            "Word-set insert started: slug=%s overwrite_mode=%s cards=%s",
            preview.spec.slug,
            preview.spec.overwrite_mode,
            preview.spec.desired_card_count,
        )
        deck_payload = {
            "slug": preview.spec.slug,
            "title": preview.spec.title,
            "description": preview.spec.description,
            "language_from": preview.spec.language_from,
            "language_to": preview.spec.language_to,
            "cards": [
                self._build_draft_card_payload(card=card, spec=preview.spec)
                for card in preview.cards[: preview.spec.desired_card_count]
            ],
        }

        with get_connection() as connection:
            result = upsert_deck(connection, deck_payload, on_existing=preview.spec.overwrite_mode)
            connection.commit()

        logger.info(
            "Word-set insert completed: slug=%s deck_id=%s inserted=%s updated=%s deleted=%s",
            preview.spec.slug,
            result.deck_id,
            result.inserted_cards,
            result.updated_cards,
            result.deleted_cards,
        )

        return {
            "spec": preview.spec,
            "blueprint": preview.blueprint,
            "warnings": preview.warnings,
            "rejected_cards": preview.rejected_cards,
            "deck_id": result.deck_id,
            "created_deck": result.created_deck,
            "inserted_cards": result.inserted_cards,
            "updated_cards": result.updated_cards,
            "deleted_cards": result.deleted_cards,
            "total_cards": result.total_cards,
            "phase_summary": self._build_phase_summary(draft_cards=result.total_cards, refined_cards=0),
        }

    def enrich_generated_deck(
        self,
        deck_id: int,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        return self._enrich_generated_deck(
            deck_id=deck_id,
            spec=None,
            max_repair_attempts=max_repair_attempts,
            api_key=api_key,
        )

    def _enrich_generated_deck(
        self,
        *,
        deck_id: int,
        spec: DeckGenerationSpec | None,
        max_repair_attempts: int,
        api_key: str | None,
    ) -> dict[str, Any]:
        initialize_database()
        with get_connection() as connection:
            deck_row = connection.execute(
                "SELECT id, slug, title, description FROM decks WHERE id = ?",
                (deck_id,),
            ).fetchone()
            if deck_row is None:
                raise SpecError(f"Deck {deck_id} not found")

            draft_rows = connection.execute(
                """
                SELECT id, spanish_text, english_text, section_name, generation_metadata
                FROM cards
                WHERE deck_id = ? AND generation_phase = 'draft'
                ORDER BY COALESCE(section_name, ''), id ASC
                """,
                (deck_id,),
            ).fetchall()

            if not draft_rows:
                phase_counts = self._count_generation_phases(connection, deck_id)
                return {
                    "deck_id": deck_id,
                    "enriched_cards": 0,
                    "remaining_draft_cards": phase_counts["draft_cards"],
                    "phase_summary": self._build_phase_summary(**phase_counts),
                    "warnings": [],
                    "rejected_cards": [],
                }

            grouped_rows = self._group_draft_rows_by_section(draft_rows)
            rejected_cards: list[RejectedCard] = []
            warnings: list[str] = []
            enriched_cards = 0

            for section_name, rows in grouped_rows.items():
                context_spec = spec or self._build_spec_from_draft_rows(deck_row=deck_row, rows=rows)
                batch_size = min(max(context_spec.batch_size, 4), 12)
                for batch_start in range(0, len(rows), batch_size):
                    batch_rows = rows[batch_start : batch_start + batch_size]
                    payload, used_model = self._chat_json_with_fallback(
                        spec=context_spec,
                        operation_name="card_enrichment",
                        system_prompt=_enrichment_system_prompt(),
                        user_prompt=_build_enrichment_prompt(spec=context_spec, section_name=section_name, rows=batch_rows),
                        temperature=0.1,
                        api_key=api_key,
                    )
                    if used_model != context_spec.model:
                        warnings.append(
                            f"Enrichment for section '{section_name or context_spec.title}' fell back from {context_spec.model} to {used_model}"
                        )
                    accepted_batch, rejected_batch = self._parse_and_validate_enriched_cards(
                        payload=payload,
                        spec=context_spec,
                        requested_rows=batch_rows,
                    )
                    if rejected_batch and max_repair_attempts > 0:
                        repaired_cards, rejected_batch, repair_warnings = self._repair_enriched_cards(
                            spec=context_spec,
                            section_name=section_name,
                            requested_rows=batch_rows,
                            rejected_cards=rejected_batch,
                            max_repair_attempts=max_repair_attempts,
                            preferred_models=[used_model, *context_spec.fallback_models, context_spec.model],
                            api_key=api_key,
                        )
                        accepted_batch.extend(repaired_cards)
                        warnings.extend(repair_warnings)
                    rejected_cards.extend(rejected_batch)
                    enriched_cards += self._persist_enriched_cards(connection=connection, rows=batch_rows, cards=accepted_batch)

            connection.commit()
            phase_counts = self._count_generation_phases(connection, deck_id)

        return {
            "deck_id": deck_id,
            "enriched_cards": enriched_cards,
            "remaining_draft_cards": phase_counts["draft_cards"],
            "phase_summary": self._build_phase_summary(**phase_counts),
            "warnings": warnings,
            "rejected_cards": rejected_cards,
        }

    def generate_all_and_insert(
        self,
        spec_path: str,
        *,
        max_repair_attempts: int = 1,
        api_key: str | None = None,
    ) -> list[GenerateDeckResponse]:
        results: list[GenerateDeckResponse] = []
        specs = self.load_specs(spec_path)
        logger.info("Batch generation started: spec_path=%s deck_count=%s", spec_path, len(specs))
        for index, spec in enumerate(specs, start=1):
            logger.info("Batch deck started: index=%s/%s slug=%s", index, len(specs), spec.slug)
            result = self._generate_spec_and_insert(spec, max_repair_attempts=max_repair_attempts, api_key=api_key)
            results.append(GenerateDeckResponse(**result))
            logger.info("Batch deck completed: index=%s/%s slug=%s", index, len(specs), spec.slug)
        logger.info("Batch generation completed: spec_path=%s deck_count=%s", spec_path, len(results))
        return results

    def _build_blueprint(self, spec: DeckGenerationSpec, *, api_key: str | None = None) -> tuple[DeckBlueprint, list[str]]:
        if spec.sections:
            logger.info("Using spec-defined blueprint sections: slug=%s section_count=%s", spec.slug, len(spec.sections))
            return (
                DeckBlueprint(
                    pedagogical_goal=f"Build a {spec.difficulty} Spanish-to-English deck on {spec.topic} for focused review.",
                    sections=[
                        DeckBlueprintSection(
                            name=section.name,
                            communicative_goal=section.communicative_goal,
                            lexical_focus=section.lexical_focus,
                            target_card_count=section.target_card_count,
                        )
                        for section in spec.sections
                    ],
                ),
                [],
            )

        system_prompt = (
            "You design vocabulary decks for Spanish speakers learning English. "
            "Return JSON only. Balance coverage, avoid duplicate ideas, and keep sections practical for spaced repetition."
        )
        user_prompt = json.dumps(
            {
                "task": "Create a deck blueprint for Spanish to English flashcards.",
                "required_output": {
                    "pedagogical_goal": "string",
                    "sections": [
                        {
                            "name": "string",
                            "communicative_goal": "string",
                            "lexical_focus": ["string"],
                            "target_card_count": 4,
                        }
                    ],
                },
                "constraints": {
                    "desired_card_count": spec.desired_card_count,
                    "topic": spec.topic,
                    "difficulty": spec.difficulty,
                    "learner_profile": spec.learner_profile,
                    "vocabulary_focus": spec.vocabulary_focus,
                    "excluded_vocabulary": spec.excluded_vocabulary,
                    "generation_notes": spec.generation_notes,
                },
                "rules": [
                    "The sum of target_card_count across sections must equal desired_card_count.",
                    "Use 2 to 5 sections.",
                    "Each section should cover a distinct communicative slice.",
                    "Keep lexical_focus concrete and non-overlapping.",
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        blueprint_payload, used_model = self._chat_json_with_fallback(
            spec=spec,
            operation_name="blueprint_generation",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=0.1,
            api_key=api_key,
        )
        try:
            blueprint = DeckBlueprint.model_validate(blueprint_payload)
        except ValidationError as exc:
            raise OllamaError(f"Blueprint validation failed: {exc}") from exc

        if sum(section.target_card_count for section in blueprint.sections) != spec.desired_card_count:
            raise OllamaError("Blueprint target_card_count does not match desired_card_count")
        warnings: list[str] = []
        if used_model != spec.model:
            warnings.append(f"Blueprint generation fell back from {spec.model} to {used_model}")
        logger.info("Blueprint generation completed: slug=%s section_count=%s model=%s", spec.slug, len(blueprint.sections), used_model)
        return blueprint, warnings

    def _generate_cards(
        self,
        spec: DeckGenerationSpec,
        blueprint: DeckBlueprint,
        *,
        max_repair_attempts: int,
        api_key: str | None,
    ) -> tuple[list[GeneratedCard], list[str], list[RejectedCard]]:
        accepted_cards: list[GeneratedCard] = []
        warnings: list[str] = []
        rejected_cards: list[RejectedCard] = []
        seen_pairs: set[tuple[str, str]] = set()

        for section in blueprint.sections:
            target = section.target_card_count
            section_cards: list[GeneratedCard] = []
            attempts = 0
            max_section_attempts = max(3, target // 4 + 1)
            logger.info("Section generation started: slug=%s section=%s target=%s", spec.slug, section.name, target)

            while len(section_cards) < target and attempts < max_section_attempts:
                attempts += 1
                requested_count = min(spec.batch_size, target - len(section_cards) + 2)
                logger.info(
                    "Section generation attempt: slug=%s section=%s attempt=%s/%s requested_count=%s current_cards=%s",
                    spec.slug,
                    section.name,
                    attempts,
                    max_section_attempts,
                    requested_count,
                    len(section_cards),
                )
                candidate_payload, used_model = self._chat_json_with_fallback(
                    spec=spec,
                    operation_name="card_generation",
                    system_prompt=_card_generation_system_prompt(),
                    user_prompt=_build_card_generation_prompt(
                        spec=spec,
                        section=section,
                        requested_count=requested_count,
                        existing_cards=accepted_cards + section_cards,
                    ),
                    temperature=0.15,
                    api_key=api_key,
                )
                if used_model != spec.model:
                    warnings.append(f"Card generation for section '{section.name}' fell back from {spec.model} to {used_model}")
                accepted_batch, rejected_batch = self._parse_and_validate_cards(
                    payload=candidate_payload,
                    spec=spec,
                    seen_pairs=seen_pairs,
                )
                if rejected_batch and max_repair_attempts > 0:
                    logger.info(
                        "Section repair started: slug=%s section=%s rejected=%s",
                        spec.slug,
                        section.name,
                        len(rejected_batch),
                    )
                    repaired_cards, repaired_rejections, repair_warnings = self._repair_cards(
                        spec=spec,
                        section=section,
                        rejected_cards=rejected_batch,
                        seen_pairs=seen_pairs,
                        max_repair_attempts=max_repair_attempts,
                        preferred_models=[used_model, *spec.fallback_models, spec.model],
                        api_key=api_key,
                    )
                    warnings.extend(repair_warnings)
                    accepted_batch.extend(repaired_cards)
                    rejected_batch = repaired_rejections
                    logger.info(
                        "Section repair completed: slug=%s section=%s repaired=%s remaining_rejected=%s",
                        spec.slug,
                        section.name,
                        len(repaired_cards),
                        len(rejected_batch),
                    )

                for card in accepted_batch:
                    card = card.model_copy(update={"section_name": section.name})
                    pair = (card.spanish.casefold(), card.english.casefold())
                    if pair in seen_pairs or len(section_cards) >= target:
                        continue
                    seen_pairs.add(pair)
                    section_cards.append(card)

                rejected_cards.extend(rejected_batch)
                logger.info(
                    "Section attempt completed: slug=%s section=%s accepted_so_far=%s rejected_total=%s",
                    spec.slug,
                    section.name,
                    len(section_cards),
                    len(rejected_cards),
                )

            if len(section_cards) < target:
                warnings.append(
                    f"Section '{section.name}' produced {len(section_cards)} valid cards out of {target} requested"
                )
            logger.info(
                "Section generation finished: slug=%s section=%s accepted=%s target=%s",
                spec.slug,
                section.name,
                len(section_cards),
                target,
            )

            accepted_cards.extend(section_cards)

        if len(accepted_cards) > spec.desired_card_count:
            accepted_cards = accepted_cards[: spec.desired_card_count]

        return accepted_cards, warnings, rejected_cards

    def _build_draft_card_payload(self, *, card: GeneratedCard, spec: DeckGenerationSpec) -> dict[str, Any]:
        return {
            "spanish": card.spanish,
            "english": card.english,
            "section_name": card.section_name,
            "part_of_speech": None,
            "definition_en": None,
            "main_translations_es": [],
            "collocations": [],
            "example_sentence": None,
            "example_es": None,
            "example_en": None,
            "generation_phase": "draft",
            "generation_metadata": {
                "slug": spec.slug,
                "topic": spec.topic,
                "difficulty": spec.difficulty,
                "learner_profile": spec.learner_profile,
                "generation_notes": spec.generation_notes,
                "model_provider": spec.model_provider,
                "model": spec.model,
                "fallback_models": spec.fallback_models,
                "batch_size": spec.batch_size,
                "word_set_prompt_version": WORD_SET_PROMPT_VERSION,
            },
        }

    def _parse_and_validate_enriched_cards(
        self,
        *,
        payload: dict[str, Any],
        spec: DeckGenerationSpec,
        requested_rows: list[Any],
    ) -> tuple[list[GeneratedCard], list[RejectedCard]]:
        accepted_cards, rejected_cards = self._parse_and_validate_cards(
            payload=payload,
            spec=spec,
            seen_pairs=set(),
            require_details=True,
        )
        requested_pairs = {
            (row["spanish_text"].casefold(), row["english_text"].casefold()): row
            for row in requested_rows
        }
        matched_pairs: set[tuple[str, str]] = set()
        filtered_cards: list[GeneratedCard] = []

        for card in accepted_cards:
            pair = (card.spanish.casefold(), card.english.casefold())
            if pair not in requested_pairs:
                rejected_cards.append(
                    RejectedCard(
                        raw_card=card.model_dump(mode="json"),
                        issues=["Card pair was not requested for enrichment"],
                    )
                )
                continue
            if pair in matched_pairs:
                rejected_cards.append(
                    RejectedCard(
                        raw_card=card.model_dump(mode="json"),
                        issues=["Duplicate enriched card pair in response"],
                    )
                )
                continue
            matched_pairs.add(pair)
            filtered_cards.append(card)

        for pair, row in requested_pairs.items():
            if pair in matched_pairs:
                continue
            rejected_cards.append(
                RejectedCard(
                    raw_card={
                        "spanish": row["spanish_text"],
                        "english": row["english_text"],
                        "section_name": row["section_name"],
                    },
                    issues=["Missing enriched card for requested pair"],
                )
            )

        return filtered_cards, rejected_cards

    def _repair_enriched_cards(
        self,
        *,
        spec: DeckGenerationSpec,
        section_name: str | None,
        requested_rows: list[Any],
        rejected_cards: list[RejectedCard],
        max_repair_attempts: int,
        preferred_models: list[str] | None = None,
        api_key: str | None = None,
    ) -> tuple[list[GeneratedCard], list[RejectedCard], list[str]]:
        current_rejections = rejected_cards
        accepted_cards: list[GeneratedCard] = []
        warnings: list[str] = []

        for _ in range(max_repair_attempts):
            if not current_rejections:
                break
            repair_payload, used_model = self._chat_json_with_fallback(
                spec=spec,
                operation_name="enrichment_repair",
                system_prompt=_enrichment_repair_system_prompt(),
                user_prompt=_build_enrichment_repair_prompt(
                    spec=spec,
                    section_name=section_name,
                    requested_rows=requested_rows,
                    rejected_cards=current_rejections,
                ),
                temperature=0.05,
                preferred_models=preferred_models,
                api_key=api_key,
            )
            if used_model != spec.model:
                warnings.append(
                    f"Enrichment repair for section '{section_name or spec.title}' fell back from {spec.model} to {used_model}"
                )
            accepted_batch, current_rejections = self._parse_and_validate_enriched_cards(
                payload=repair_payload,
                spec=spec,
                requested_rows=requested_rows,
            )
            accepted_cards.extend(accepted_batch)

        return accepted_cards, current_rejections, warnings

    def _persist_enriched_cards(self, *, connection: Any, rows: list[Any], cards: list[GeneratedCard]) -> int:
        if not cards:
            return 0
        row_by_pair = {
            (row["spanish_text"].casefold(), row["english_text"].casefold()): row
            for row in rows
        }
        updated_count = 0
        for card in cards:
            pair = (card.spanish.casefold(), card.english.casefold())
            row = row_by_pair.get(pair)
            if row is None:
                continue
            metadata = _decode_generation_metadata(row["generation_metadata"])
            metadata["enrichment_prompt_version"] = ENRICHMENT_PROMPT_VERSION
            connection.execute(
                """
                UPDATE cards
                SET
                    generation_phase = 'refined',
                    generation_metadata = ?,
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
                    json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                    card.part_of_speech,
                    card.definition_en,
                    json.dumps(card.main_translations_es, ensure_ascii=False),
                    json.dumps(card.collocations, ensure_ascii=False),
                    card.example_sentence,
                    card.example_es,
                    card.example_en,
                    row["id"],
                ),
            )
            updated_count += 1
        return updated_count

    def _count_generation_phases(self, connection: Any, deck_id: int) -> dict[str, int]:
        row = connection.execute(
            """
            SELECT
                COALESCE(SUM(CASE WHEN generation_phase = 'draft' THEN 1 ELSE 0 END), 0) AS draft_cards,
                COALESCE(SUM(CASE WHEN generation_phase = 'refined' THEN 1 ELSE 0 END), 0) AS refined_cards,
                COUNT(*) AS total_cards
            FROM cards
            WHERE deck_id = ?
            """,
            (deck_id,),
        ).fetchone()
        return {
            "draft_cards": int(row["draft_cards"]),
            "refined_cards": int(row["refined_cards"]),
            "total_cards": int(row["total_cards"]),
        }

    def _build_phase_summary(self, *, draft_cards: int, refined_cards: int, total_cards: int | None = None) -> GenerationPhaseSummary:
        resolved_total = refined_cards + draft_cards if total_cards is None else total_cards
        generation_phase = "refined" if resolved_total > 0 and draft_cards == 0 else "draft"
        return GenerationPhaseSummary(
            generation_phase=generation_phase,
            draft_cards=draft_cards,
            refined_cards=refined_cards,
            total_cards=resolved_total,
        )

    def _group_draft_rows_by_section(self, rows: list[Any]) -> dict[str | None, list[Any]]:
        grouped: dict[str | None, list[Any]] = {}
        for row in rows:
            grouped.setdefault(row["section_name"], []).append(row)
        return grouped

    def _build_spec_from_draft_rows(self, *, deck_row: Any, rows: list[Any]) -> DeckGenerationSpec:
        metadata = _decode_generation_metadata(rows[0]["generation_metadata"])
        return DeckGenerationSpec(
            slug=str(metadata.get("slug") or deck_row["slug"]),
            title=str(deck_row["title"]),
            description=str(deck_row["description"]),
            topic=str(metadata.get("topic") or deck_row["title"]),
            difficulty=str(metadata.get("difficulty") or "beginner"),
            desired_card_count=max(len(rows), 4),
            batch_size=min(max(int(metadata.get("batch_size") or len(rows) or 4), 4), 20),
            model_provider=str(metadata.get("model_provider") or "ollama"),
            model=str(metadata.get("model") or "qwen3.5:latest"),
            fallback_models=[str(item) for item in metadata.get("fallback_models", []) if isinstance(item, str)],
            overwrite_mode="append",
            language_from="es",
            language_to="en",
            learner_profile=metadata.get("learner_profile") if isinstance(metadata.get("learner_profile"), str) else None,
            generation_notes=metadata.get("generation_notes") if isinstance(metadata.get("generation_notes"), str) else None,
            vocabulary_focus=[],
            excluded_vocabulary=[],
            sections=[],
        )

    def _parse_and_validate_cards(
        self,
        *,
        payload: dict[str, Any],
        spec: DeckGenerationSpec,
        seen_pairs: set[tuple[str, str]],
        require_details: bool = False,
    ) -> tuple[list[GeneratedCard], list[RejectedCard]]:
        raw_cards = _extract_card_list(payload)

        accepted_cards: list[GeneratedCard] = []
        rejected_cards: list[RejectedCard] = []
        excluded_terms = {term.casefold() for term in spec.excluded_vocabulary}

        for raw_card in raw_cards:
            if not isinstance(raw_card, dict):
                rejected_cards.append(RejectedCard(raw_card={"value": raw_card}, issues=["Card must be an object"]))
                continue

            try:
                card = GeneratedCard.model_validate(raw_card)
            except ValidationError as exc:
                rejected_cards.append(
                    RejectedCard(
                        raw_card=raw_card,
                        issues=[f"{'.'.join(str(part) for part in error_item['loc'])}: {error_item['msg']}" for error_item in exc.errors()],
                    )
                )
                continue

            issues = _validate_card_quality(
                card,
                excluded_terms=excluded_terms,
                seen_pairs=seen_pairs,
                require_details=require_details,
            )
            if issues:
                rejected_cards.append(RejectedCard(raw_card=card.model_dump(mode="json"), issues=issues))
                continue

            accepted_cards.append(card)

        issue_counter: Counter[str] = Counter()
        for rejected_card in rejected_cards:
            issue_counter.update(rejected_card.issues)
        logger.info(
            "Card batch validated: accepted=%s rejected=%s excluded_terms=%s issues=%s",
            len(accepted_cards),
            len(rejected_cards),
            len(excluded_terms),
            dict(issue_counter),
        )
        return accepted_cards, rejected_cards

    def _repair_cards(
        self,
        *,
        spec: DeckGenerationSpec,
        section: DeckBlueprintSection,
        rejected_cards: list[RejectedCard],
        seen_pairs: set[tuple[str, str]],
        max_repair_attempts: int,
        preferred_models: list[str] | None = None,
        api_key: str | None = None,
    ) -> tuple[list[GeneratedCard], list[RejectedCard], list[str]]:
        current_rejections = rejected_cards
        accepted_cards: list[GeneratedCard] = []
        warnings: list[str] = []

        for _ in range(max_repair_attempts):
            if not current_rejections:
                break

            repair_payload, used_model = self._chat_json_with_fallback(
                spec=spec,
                operation_name="card_repair",
                system_prompt=_repair_system_prompt(),
                user_prompt=_build_repair_prompt(spec=spec, section=section, rejected_cards=current_rejections),
                temperature=0.05,
                preferred_models=preferred_models,
                api_key=api_key,
            )
            if used_model != spec.model:
                warnings.append(f"Repair generation for section '{section.name}' fell back from {spec.model} to {used_model}")
            accepted_batch, current_rejections = self._parse_and_validate_cards(
                payload=repair_payload,
                spec=spec,
                seen_pairs=seen_pairs,
            )
            accepted_cards.extend(accepted_batch)
            logger.info(
                "Repair attempt completed: section=%s accepted=%s remaining_rejected=%s",
                section.name,
                len(accepted_cards),
                len(current_rejections),
            )

        return accepted_cards, current_rejections, warnings

    def _chat_json_with_fallback(
        self,
        *,
        spec: DeckGenerationSpec,
        operation_name: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        preferred_models: list[str] | None = None,
        api_key: str | None = None,
    ) -> tuple[dict[str, Any], str]:
        attempted_models: list[str] = []
        errors: list[str] = []
        candidate_models = preferred_models or [spec.model, *spec.fallback_models]
        for model_name in candidate_models:
            if model_name in attempted_models:
                continue
            attempted_models.append(model_name)
            logger.info(
                "Inference attempt started: slug=%s operation=%s provider=%s model=%s attempt=%s",
                spec.slug,
                operation_name,
                spec.model_provider,
                model_name,
                len(attempted_models),
            )
            started_at = time.perf_counter()
            try:
                response = self.ollama_client.chat_json(
                    provider=spec.model_provider,
                    model=model_name,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    temperature=temperature,
                    api_key=api_key,
                )
            except OllamaError as exc:
                errors.append(str(exc))
                logger.warning(
                    "Inference attempt failed: slug=%s operation=%s provider=%s model=%s attempt=%s elapsed_ms=%s error=%s",
                    spec.slug,
                    operation_name,
                    spec.model_provider,
                    model_name,
                    len(attempted_models),
                    _elapsed_ms(started_at),
                    exc,
                )
                continue
            logger.info(
                "Inference attempt succeeded: slug=%s operation=%s provider=%s model=%s attempt=%s elapsed_ms=%s",
                spec.slug,
                operation_name,
                spec.model_provider,
                model_name,
                len(attempted_models),
                _elapsed_ms(started_at),
            )
            return response, model_name

        raise OllamaError(
            f"All candidate {spec.model_provider} models failed: " + " | ".join(errors)
        )


def _resolve_spec_path(spec_path: str) -> Path:
    raw_path = Path(spec_path)
    if raw_path.is_absolute():
        return raw_path
    return (BASE_DIR / raw_path).resolve() if raw_path.parts[:1] == ("generator_specs",) else (SPEC_DIR / raw_path).resolve()


def _extract_deck_payloads(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        if not payload:
            raise SpecError("Spec file must contain at least one deck")
        if not all(isinstance(item, dict) for item in payload):
            raise SpecError("Spec list entries must be objects")
        return payload

    if not isinstance(payload, dict):
        raise SpecError("Spec file must contain a JSON or YAML object or a list of deck objects")

    if "decks" in payload:
        decks = payload["decks"]
        if not isinstance(decks, list) or not decks:
            raise SpecError("'decks' must be a non-empty list")
        if not all(isinstance(item, dict) for item in decks):
            raise SpecError("Each item in 'decks' must be an object")
        return decks

    if "deck" in payload:
        deck = payload["deck"]
        if not isinstance(deck, dict):
            raise SpecError("'deck' must be an object")
        return [deck]

    return [payload]


def _extract_json_text(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        return stripped

    object_start = stripped.find("{")
    array_start = stripped.find("[")
    candidates = [position for position in (object_start, array_start) if position != -1]
    if not candidates:
        raise json.JSONDecodeError("No JSON object found", value, 0)

    start = min(candidates)
    end = max(stripped.rfind("}"), stripped.rfind("]"))
    if end < start:
        raise json.JSONDecodeError("No JSON terminator found", value, start)
    return stripped[start : end + 1]


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((time.perf_counter() - started_at) * 1000))


def _extract_openai_message_content(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise OllamaError("OpenAI response did not include any choices")

    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise OllamaError("OpenAI response did not include a message payload")

    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            text_value = item.get("text")
            if isinstance(text_value, str):
                text_parts.append(text_value)
        return "\n".join(text_parts)

    raise OllamaError("OpenAI response message content was not textual")


def _extract_card_list(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload

    if not isinstance(payload, dict):
        raise OllamaError("Card generation payload must be a JSON object or list")

    direct_cards = payload.get("cards")
    if isinstance(direct_cards, list):
        return direct_cards

    for key in ("flashcards", "items", "entries", "results", "vocabulary"):
        candidate = payload.get(key)
        if isinstance(candidate, list):
            return candidate

    list_keys = [key for key, value in payload.items() if isinstance(value, list)]
    if len(list_keys) == 1:
        return payload[list_keys[0]]

    available_keys = ", ".join(sorted(payload.keys())) or "none"
    raise OllamaError(
        "Card generation payload must contain a top-level list of cards; "
        f"available keys: {available_keys}"
    )


def _card_generation_system_prompt() -> str:
    return (
        "You design high-quality Spanish to English flashcard word sets for Spanish-speaking learners. "
        "Return JSON only. Focus on building a coherent, well-distributed set of card pairs before any metadata is added. "
        "Avoid duplicate concepts, avoid trivial variants, and keep each pair practical for spaced repetition."
    )


def _enrichment_system_prompt() -> str:
    return (
        "You enrich an existing Spanish to English flashcard set with high-quality learning metadata. "
        "Return JSON only with a top-level 'cards' list. Preserve every Spanish-English pair exactly as requested. "
        "Add concise, natural linguistic details: part_of_speech, definition_en, 1 to 3 main_translations_es, 2 to 4 collocations, "
        "and mutually consistent example_sentence, example_es, example_en."
    )


def _repair_system_prompt() -> str:
    return (
        "You repair invalid flashcard JSON for Spanish to English learning decks. "
        "Return JSON only with a top-level 'cards' list. Fix the reported issues and keep cards natural and concise. "
        "Preserve the language direction exactly: Spanish prompt, English answer, English example_sentence, Spanish example_es, English example_en."
    )


def _enrichment_repair_system_prompt() -> str:
    return (
        "You repair invalid enriched flashcard JSON for Spanish to English learning decks. "
        "Return JSON only with a top-level 'cards' list. Preserve the requested Spanish-English pairs exactly and fix only the reported issues."
    )


def _build_card_generation_prompt(
    *,
    spec: DeckGenerationSpec,
    section: DeckBlueprintSection,
    requested_count: int,
    existing_cards: list[GeneratedCard],
) -> str:
    existing_pairs = [f"{card.spanish} -> {card.english}" for card in existing_cards]
    payload = {
        "task": "Generate Spanish to English flashcards",
        "deck": {
            "slug": spec.slug,
            "title": spec.title,
            "description": spec.description,
            "topic": spec.topic,
            "difficulty": spec.difficulty,
            "learner_profile": spec.learner_profile,
            "generation_notes": spec.generation_notes,
        },
        "section": section.model_dump(mode="json"),
        "requested_count": requested_count,
        "excluded_vocabulary": spec.excluded_vocabulary,
        "must_avoid_pairs": existing_pairs,
        "required_output": {
            "cards": [
                {
                    "spanish": "string",
                    "english": "string",
                }
            ]
        },
        "rules": [
            "Return exactly the requested number of cards if possible.",
            "Spanish must be the prompt and English must be the answer.",
            "Do not repeat a Spanish-English pair that already exists.",
            "Do not output metadata fields in this phase; only output spanish and english.",
            "Distribute the set across the section's lexical focus instead of clustering around one subtopic.",
            "Prefer communicatively distinct cards over near-synonyms or inflectional variants.",
            "Mix useful nouns, verbs, expressions, and questions when natural for the section.",
            "Keep the English answer short, natural, and learner-friendly.",
            "Avoid meta commentary, markdown, or explanations outside the JSON.",
            "Keep cards aligned to the requested section and difficulty.",
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _build_enrichment_prompt(*, spec: DeckGenerationSpec, section_name: str | None, rows: list[Any]) -> str:
    payload = {
        "task": "Enrich an existing Spanish to English flashcard set",
        "deck": {
            "slug": spec.slug,
            "title": spec.title,
            "description": spec.description,
            "topic": spec.topic,
            "difficulty": spec.difficulty,
            "learner_profile": spec.learner_profile,
            "generation_notes": spec.generation_notes,
        },
        "section_name": section_name,
        "cards_to_enrich": [
            {
                "spanish": row["spanish_text"],
                "english": row["english_text"],
            }
            for row in rows
        ],
        "required_output": {
            "cards": [
                {
                    "spanish": "string",
                    "english": "string",
                    "part_of_speech": "string",
                    "definition_en": "string",
                    "main_translations_es": ["string"],
                    "collocations": ["string"],
                    "example_sentence": "string",
                    "example_es": "string",
                    "example_en": "string",
                }
            ]
        },
        "rules": [
            "Return one enriched card for every requested pair.",
            "Preserve spanish and english exactly as requested.",
            "definition_en must be concise and natural.",
            "main_translations_es must contain 1 to 3 short Spanish variants or close equivalents.",
            "collocations must contain 2 to 4 natural English collocations.",
            "example_sentence must be an English sentence that uses the English answer naturally.",
            "example_es must be Spanish and example_en must be the English counterpart.",
            "All example fields are required and must be mutually consistent.",
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _build_repair_prompt(
    *,
    spec: DeckGenerationSpec,
    section: DeckBlueprintSection,
    rejected_cards: list[RejectedCard],
) -> str:
    payload = {
        "task": "Repair invalid flashcards without changing the deck intent",
        "deck": {
            "slug": spec.slug,
            "topic": spec.topic,
            "difficulty": spec.difficulty,
        },
        "section": section.model_dump(mode="json"),
        "rejected_cards": [card.model_dump(mode="json") for card in rejected_cards],
        "required_output": {
            "cards": [
                {
                    "spanish": "string",
                    "english": "string",
                    "part_of_speech": "string",
                    "definition_en": "string",
                    "main_translations_es": ["string"],
                    "collocations": ["string"],
                    "example_sentence": "string",
                    "example_es": "string",
                    "example_en": "string",
                }
            ]
        },
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _build_enrichment_repair_prompt(
    *,
    spec: DeckGenerationSpec,
    section_name: str | None,
    requested_rows: list[Any],
    rejected_cards: list[RejectedCard],
) -> str:
    payload = {
        "task": "Repair invalid enriched flashcards without changing the requested pairs",
        "deck": {
            "slug": spec.slug,
            "topic": spec.topic,
            "difficulty": spec.difficulty,
        },
        "section_name": section_name,
        "requested_pairs": [
            {
                "spanish": row["spanish_text"],
                "english": row["english_text"],
            }
            for row in requested_rows
        ],
        "rejected_cards": [card.model_dump(mode="json") for card in rejected_cards],
        "required_output": {
            "cards": [
                {
                    "spanish": "string",
                    "english": "string",
                    "part_of_speech": "string",
                    "definition_en": "string",
                    "main_translations_es": ["string"],
                    "collocations": ["string"],
                    "example_sentence": "string",
                    "example_es": "string",
                    "example_en": "string",
                }
            ]
        },
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _validate_card_quality(
    card: GeneratedCard,
    *,
    excluded_terms: set[str],
    seen_pairs: set[tuple[str, str]],
    require_details: bool,
) -> list[str]:
    issues: list[str] = []
    pair = (card.spanish.casefold(), card.english.casefold())
    if pair in seen_pairs:
        issues.append("Duplicate Spanish-English pair")
    if card.spanish.casefold() == card.english.casefold():
        issues.append("Spanish and English text cannot be identical")
    if require_details:
        if not card.part_of_speech:
            issues.append("part_of_speech is required")
        if not card.definition_en:
            issues.append("definition_en is required")
        if not 1 <= len(card.main_translations_es) <= 3:
            issues.append("main_translations_es must contain between 1 and 3 items")
        if not 2 <= len(card.collocations) <= 4:
            issues.append("collocations must contain between 2 and 4 items")
        if not card.example_sentence or not card.example_es or not card.example_en:
            issues.append("example_sentence, example_es, and example_en are all required")
        if card.example_sentence and _contains_inverted_punctuation(card.example_sentence):
            issues.append("example_sentence must be in English, not Spanish punctuation")
        if card.example_en and _contains_inverted_punctuation(card.example_en):
            issues.append("example_en must be in English, not Spanish punctuation")
        if card.example_es and _looks_english_like(card.example_es):
            issues.append("example_es appears to be English instead of Spanish")
        if card.example_sentence and _looks_spanish_like(card.example_sentence):
            issues.append("example_sentence appears to be Spanish instead of English")
        if card.example_en and _looks_spanish_like(card.example_en):
            issues.append("example_en appears to be Spanish instead of English")
    if excluded_terms and any(term in card.spanish.casefold() for term in excluded_terms):
        issues.append("Card uses excluded vocabulary")
    return issues


def _decode_generation_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _contains_inverted_punctuation(value: str) -> bool:
    return "¿" in value or "¡" in value


def _looks_spanish_like(value: str) -> bool:
    lowered = value.casefold()
    spanish_markers = (
        " el ",
        " la ",
        " los ",
        " las ",
        " un ",
        " una ",
        " por favor",
        " café",
        " leche",
        " cuenta",
        " qué ",
        " cuánto",
        " dónde",
        " necesito",
    )
    padded = f" {lowered} "
    return any(marker in padded for marker in spanish_markers) or _contains_inverted_punctuation(value)


def _looks_english_like(value: str) -> bool:
    lowered = value.casefold()
    english_markers = (
        " the ",
        " a ",
        " an ",
        " please",
        " bill",
        " coffee",
        " milk",
        " what ",
        " where ",
        " how much",
        " i need",
    )
    padded = f" {lowered} "
    return any(marker in padded for marker in english_markers)