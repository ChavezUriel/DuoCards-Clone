from __future__ import annotations

from collections import Counter
import json
import logging
from pathlib import Path
from typing import Any
from urllib import error, request

import yaml
from pydantic import ValidationError

from app.db import get_connection, initialize_database, upsert_deck

from .schemas import (
    DeckBlueprint,
    DeckBlueprintSection,
    DeckGenerationSpec,
    DeckPreview,
    GenerateDeckResponse,
    GeneratedCard,
    RejectedCard,
    SpecFileInfo,
)

BASE_DIR = Path(__file__).resolve().parent.parent
SPEC_DIR = BASE_DIR / "generator_specs"
MODEL_ALIASES = {
    "gpt:oss-20b": "gpt-oss:20b",
}
OLLAMA_REQUEST_TIMEOUT_SECONDS = 600
logger = logging.getLogger("generator_app.service")


class OllamaError(RuntimeError):
    pass


class SpecError(ValueError):
    pass


class OllamaClient:
    def __init__(self, base_url: str = "http://127.0.0.1:11434") -> None:
        self.base_url = base_url.rstrip("/")

    def chat_json(self, *, model: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> dict[str, Any]:
        resolved_model = MODEL_ALIASES.get(model, model)
        logger.info("Ollama chat request started: model=%s temperature=%s", resolved_model, temperature)
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
            url=f"{self.base_url}/api/chat",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with request.urlopen(http_request, timeout=OLLAMA_REQUEST_TIMEOUT_SECONDS) as response:
                response_payload = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            logger.warning("Ollama HTTP error: model=%s status=%s detail=%s", resolved_model, exc.code, detail)
            raise OllamaError(f"Ollama request failed for model '{resolved_model}' with status {exc.code}: {detail}") from exc
        except error.URLError as exc:
            logger.warning("Ollama connection error for model=%s: %s", resolved_model, exc)
            raise OllamaError("Unable to reach Ollama at http://127.0.0.1:11434") from exc
        except TimeoutError as exc:
            logger.warning("Ollama timeout: model=%s timeout_seconds=%s", resolved_model, OLLAMA_REQUEST_TIMEOUT_SECONDS)
            raise OllamaError(
                f"Ollama request timed out for model '{resolved_model}' after {OLLAMA_REQUEST_TIMEOUT_SECONDS} seconds"
            ) from exc

        content = response_payload.get("message", {}).get("content")
        if not isinstance(content, str) or not content.strip():
            logger.warning("Ollama returned empty content: model=%s", resolved_model)
            raise OllamaError("Ollama returned an empty response")

        try:
            parsed = json.loads(_extract_json_text(content))
        except json.JSONDecodeError as exc:
            logger.warning("Ollama returned invalid JSON: model=%s", resolved_model)
            raise OllamaError(f"Ollama returned invalid JSON content: {content}") from exc
        logger.info("Ollama chat request completed: model=%s", resolved_model)
        return parsed


class DeckGeneratorService:
    def __init__(self, ollama_client: OllamaClient | None = None) -> None:
        self.ollama_client = ollama_client or OllamaClient()

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

    def preview_deck(self, spec_path: str, slug: str | None = None, *, max_repair_attempts: int = 1) -> DeckPreview:
        spec = self.load_spec(spec_path, slug)
        return self._preview_spec(spec, max_repair_attempts=max_repair_attempts)

    def _preview_spec(self, spec: DeckGenerationSpec, *, max_repair_attempts: int = 1) -> DeckPreview:
        logger.info(
            "Preview pipeline started: slug=%s desired_cards=%s batch_size=%s",
            spec.slug,
            spec.desired_card_count,
            spec.batch_size,
        )
        blueprint, blueprint_warnings = self._build_blueprint(spec)
        cards, warnings, rejected_cards = self._generate_cards(spec, blueprint, max_repair_attempts=max_repair_attempts)
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

    def generate_and_insert(self, spec_path: str, slug: str | None = None, *, max_repair_attempts: int = 1) -> dict[str, Any]:
        spec = self.load_spec(spec_path, slug)
        return self._generate_spec_and_insert(spec, max_repair_attempts=max_repair_attempts)

    def _generate_spec_and_insert(self, spec: DeckGenerationSpec, *, max_repair_attempts: int = 1) -> dict[str, Any]:
        preview = self._preview_spec(spec, max_repair_attempts=max_repair_attempts)
        if len(preview.cards) < preview.spec.desired_card_count:
            raise SpecError(
                f"Generated {len(preview.cards)} valid cards, below the requested {preview.spec.desired_card_count}"
            )

        initialize_database()
        logger.info(
            "Database insert started: slug=%s overwrite_mode=%s cards=%s",
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
            "cards": [card.model_dump(mode="json") for card in preview.cards[: preview.spec.desired_card_count]],
        }

        with get_connection() as connection:
            result = upsert_deck(connection, deck_payload, on_existing=preview.spec.overwrite_mode)
            connection.commit()

        logger.info(
            "Database insert completed: slug=%s deck_id=%s inserted=%s updated=%s deleted=%s",
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
        }

    def generate_all_and_insert(self, spec_path: str, *, max_repair_attempts: int = 1) -> list[GenerateDeckResponse]:
        results: list[GenerateDeckResponse] = []
        specs = self.load_specs(spec_path)
        logger.info("Batch generation started: spec_path=%s deck_count=%s", spec_path, len(specs))
        for index, spec in enumerate(specs, start=1):
            logger.info("Batch deck started: index=%s/%s slug=%s", index, len(specs), spec.slug)
            result = self._generate_spec_and_insert(spec, max_repair_attempts=max_repair_attempts)
            results.append(GenerateDeckResponse(**result))
            logger.info("Batch deck completed: index=%s/%s slug=%s", index, len(specs), spec.slug)
        logger.info("Batch generation completed: spec_path=%s deck_count=%s", spec_path, len(results))
        return results

    def _build_blueprint(self, spec: DeckGenerationSpec) -> tuple[DeckBlueprint, list[str]]:
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
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=0.1,
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
                    system_prompt=_card_generation_system_prompt(),
                    user_prompt=_build_card_generation_prompt(
                        spec=spec,
                        section=section,
                        requested_count=requested_count,
                        existing_cards=accepted_cards + section_cards,
                    ),
                    temperature=0.15,
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

    def _parse_and_validate_cards(
        self,
        *,
        payload: dict[str, Any],
        spec: DeckGenerationSpec,
        seen_pairs: set[tuple[str, str]],
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

            issues = _validate_card_quality(card, excluded_terms=excluded_terms, seen_pairs=seen_pairs)
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
    ) -> tuple[list[GeneratedCard], list[RejectedCard], list[str]]:
        current_rejections = rejected_cards
        accepted_cards: list[GeneratedCard] = []
        warnings: list[str] = []

        for _ in range(max_repair_attempts):
            if not current_rejections:
                break

            repair_payload, used_model = self._chat_json_with_fallback(
                spec=spec,
                system_prompt=_repair_system_prompt(),
                user_prompt=_build_repair_prompt(spec=spec, section=section, rejected_cards=current_rejections),
                temperature=0.05,
                preferred_models=preferred_models,
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
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        preferred_models: list[str] | None = None,
    ) -> tuple[dict[str, Any], str]:
        attempted_models: list[str] = []
        errors: list[str] = []
        candidate_models = preferred_models or [spec.model, *spec.fallback_models]
        for model_name in candidate_models:
            if model_name in attempted_models:
                continue
            attempted_models.append(model_name)
            logger.info("Trying Ollama model: slug=%s model=%s", spec.slug, model_name)
            try:
                response = self.ollama_client.chat_json(
                    model=model_name,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    temperature=temperature,
                )
            except OllamaError as exc:
                errors.append(str(exc))
                logger.warning("Model attempt failed: slug=%s model=%s error=%s", spec.slug, model_name, exc)
                continue
            logger.info("Model attempt succeeded: slug=%s model=%s", spec.slug, model_name)
            return response, model_name

        raise OllamaError("All candidate Ollama models failed: " + " | ".join(errors))


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
        "You generate high-quality Spanish to English flashcards for Spanish-speaking learners. "
        "Return JSON only. Every card must be practical, natural, and non-duplicative. "
        "Use beginner-friendly, idiomatic English and realistic examples. "
        "The 'example_sentence' and 'example_en' fields must be English. "
        "The 'example_es' field must be Spanish."
    )


def _repair_system_prompt() -> str:
    return (
        "You repair invalid flashcard JSON for Spanish to English learning decks. "
        "Return JSON only with a top-level 'cards' list. Fix the reported issues and keep cards natural and concise. "
        "Preserve the language direction exactly: Spanish prompt, English answer, English example_sentence, Spanish example_es, English example_en."
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
            "Return exactly the requested number of cards if possible.",
            "Spanish must be the prompt and English must be the answer.",
            "Do not repeat a Spanish-English pair that already exists.",
            "main_translations_es must contain 1 to 3 short Spanish variants or close equivalents.",
            "collocations must contain 2 to 4 natural English collocations.",
            "example_sentence must be a natural English sentence that uses the English answer.",
            "example_es must be Spanish and example_en must be English.",
            "All three example fields are required and must be mutually consistent.",
            "Avoid meta commentary, markdown, or explanations outside the JSON.",
            "Keep cards aligned to the requested section and difficulty.",
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


def _validate_card_quality(
    card: GeneratedCard,
    *,
    excluded_terms: set[str],
    seen_pairs: set[tuple[str, str]],
) -> list[str]:
    issues: list[str] = []
    pair = (card.spanish.casefold(), card.english.casefold())
    if pair in seen_pairs:
        issues.append("Duplicate Spanish-English pair")
    if card.spanish.casefold() == card.english.casefold():
        issues.append("Spanish and English text cannot be identical")
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