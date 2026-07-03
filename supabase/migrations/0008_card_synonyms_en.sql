-- Adds synonyms_en to cards: English synonyms of the English answer, the
-- "original language" counterpart to main_translations_es (Spanish equivalents
-- of the Spanish prompt). Populated by the same enrichment pipeline as
-- mnemonic_en (a new dedicated sub-prompt; see supabase/scripts/lib/prompts.cjs).
--
-- What changes:
--   1. cards gains synonyms_en jsonb (NOT NULL DEFAULT '[]').
--   2. _review_card_json / _preview_card_json expose synonyms_en.
--   3. update_card gains p_synonyms_en so users can edit the list.

-- ===========================================================================
-- Schema change
-- ===========================================================================

alter table public.cards
    add column if not exists synonyms_en jsonb not null default '[]'::jsonb;

-- ===========================================================================
-- Card JSON shapes: expose synonyms_en
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
        'mnemonic_en', c.mnemonic_en
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
        'mnemonic_en', c.mnemonic_en
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

-- ===========================================================================
-- update_card gains p_synonyms_en. Drop the old signature first so inserting
-- the new parameter does not create an ambiguous overload.
-- ===========================================================================

drop function if exists public.update_card(
    bigint, text, text, text, text, text, text[], text[], text, text, text, text
);

create or replace function public.update_card(
    p_card_id bigint,
    p_prompt_es text,
    p_answer_en text,
    p_section_name text default null,
    p_part_of_speech text default null,
    p_definition_en text default null,
    p_main_translations_es text[] default '{}',
    p_collocations text[] default '{}',
    p_synonyms_en text[] default '{}',
    p_example_sentence text default null,
    p_example_es text default null,
    p_example_en text default null,
    p_mnemonic_en text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_prompt text;
    v_answer text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select d.user_id into v_owner
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to modify this card'; end if;

    v_prompt := nullif(trim(p_prompt_es), '');
    v_answer := nullif(trim(p_answer_en), '');
    if v_prompt is null then raise exception 'prompt_es must be a non-empty string'; end if;
    if v_answer is null then raise exception 'answer_en must be a non-empty string'; end if;

    update public.cards set
        spanish_text = v_prompt,
        english_text = v_answer,
        section_name = nullif(trim(p_section_name), ''),
        part_of_speech = nullif(trim(p_part_of_speech), ''),
        definition_en = nullif(trim(p_definition_en), ''),
        main_translations_es = public._norm_text_items(p_main_translations_es),
        collocations = public._norm_text_items(p_collocations),
        synonyms_en = public._norm_text_items(p_synonyms_en),
        example_sentence = nullif(trim(p_example_sentence), ''),
        example_es = nullif(trim(p_example_es), ''),
        example_en = nullif(trim(p_example_en), ''),
        mnemonic_en = nullif(trim(p_mnemonic_en), '')
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

-- ===========================================================================
-- Grants: update_card was dropped and re-created — re-apply the
-- authenticated-only policy.
-- ===========================================================================

revoke execute on function public.update_card(
    bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text
) from public, anon;
grant execute on function public.update_card(
    bigint, text, text, text, text, text, text[], text[], text[], text, text, text, text
) to authenticated;

notify pgrst, 'reload schema';