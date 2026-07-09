-- ===========================================================================
-- 0019: Multiple example sentence pairs per card (fill-in-the-blank variety).
--
-- Cards now carry `examples` — a jsonb array of matched sentence pairs
-- [{ "es": "...", "en": "..." }, ...], at least 3 per card, where every English
-- sentence contains the answer verbatim so the cloze minigames can blank it.
-- Repeat presentations of a card can then blank a DIFFERENT sentence each time
-- (frontend picks deterministically per presentation), instead of always
-- replaying the single example_en.
--
-- The legacy example_es / example_en / example_sentence columns stay and keep
-- mirroring pair 0: they are what older consumers and the 0017 market-sync
-- content hash read. Like 0018's cloze_distractors_en, `examples` is
-- deliberately NOT part of _card_sync_content — stored base_version_hash
-- values stay valid, and extra pairs never flag spurious market updates.
-- (A change to pair 0 rewrites the mirrored legacy columns, which ARE hashed —
-- so a real content change still syncs.)
--
-- User copies get the pairs via READ-THROUGH, not duplication: the card JSON
-- builders serve the card's own `examples` when non-empty, else the base
-- card's (base_card_id provenance) while the copy still answers with the same
-- english_text — the same rule 0018 uses for curated distractors, so a copy
-- always gets sentences and options that were verified together. An edited
-- copy (different answer) falls back to its own single legacy example.
--
-- The column is pipeline-owned (supabase/scripts/lib/enrich.cjs generates and
-- audits the pairs; update_cards.cjs backfills; seed.sql / seed_updates.sql
-- carry it). update_card deliberately does not expose it, so user edits can
-- never wipe the set.
-- ===========================================================================

alter table public.cards
    add column if not exists examples jsonb not null default '[]'::jsonb;

-- ===========================================================================
-- Card JSON shapes: expose `examples` (additive key; existing consumers keep
-- working). _review_card_json is what the practice queue embeds as
-- current_card, so the minigames see the pairs; _preview_card_json feeds the
-- deck explorer.
-- ===========================================================================

create or replace function public._review_card_json(p_card_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'card_id', c.id,
        'deck_id', c.deck_id,
        'deck_title', d.title,
        'section_name', coalesce(c.section_name, d.title),
        'prompt_es', c.spanish_text,
        'answer_en', c.english_text,
        'part_of_speech', c.part_of_speech,
        'definition_en', c.definition_en,
        'main_translations_es', coalesce(c.main_translations_es, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'synonyms_en', coalesce(c.synonyms_en, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_es', c.example_es,
        'example_en', c.example_en,
        'mnemonic_en', c.mnemonic_en,
        'examples', coalesce(
            case when jsonb_array_length(coalesce(c.examples, '[]'::jsonb)) > 0
                 then c.examples
                 else (
                     select bc.examples
                     from public.cards bc
                     where bc.id = c.base_card_id
                       and lower(trim(bc.english_text)) = lower(trim(c.english_text))
                       and jsonb_array_length(coalesce(bc.examples, '[]'::jsonb)) > 0
                 )
            end, '[]'::jsonb)
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

create or replace function public._preview_card_json(p_card_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'card_id', c.id,
        'prompt_es', c.spanish_text,
        'answer_en', c.english_text,
        'section_name', coalesce(c.section_name, d.title),
        'is_enabled', c.is_enabled,
        'part_of_speech', c.part_of_speech,
        'definition_en', c.definition_en,
        'main_translations_es', coalesce(c.main_translations_es, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'synonyms_en', coalesce(c.synonyms_en, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_es', c.example_es,
        'example_en', c.example_en,
        'mnemonic_en', c.mnemonic_en,
        'base_card_id', c.base_card_id,
        'examples', coalesce(
            case when jsonb_array_length(coalesce(c.examples, '[]'::jsonb)) > 0
                 then c.examples
                 else (
                     select bc.examples
                     from public.cards bc
                     where bc.id = c.base_card_id
                       and lower(trim(bc.english_text)) = lower(trim(c.english_text))
                       and jsonb_array_length(coalesce(bc.examples, '[]'::jsonb)) > 0
                 )
            end, '[]'::jsonb)
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

notify pgrst, 'reload schema';
