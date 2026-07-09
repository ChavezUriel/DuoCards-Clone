-- ===========================================================================
-- 0018: Curated cloze distractors for the word-bank cloze minigame.
--
-- Sibling-based distractors (0013/0014) come from the same deck, so for the
-- word-bank cloze they can accidentally ALSO fit the blanked example sentence
-- ("I ate an ____ for breakfast" + sibling answers apple/orange/banana). The
-- generation pipeline now curates a per-card option set written against the
-- SPECIFIC sentence and verified with a blind LLM solve-check so only the real
-- answer fits (supabase/scripts/lib/enrich.cjs; update_cards.cjs backfills
-- existing decks; seed.sql / seed_updates.sql carry the column).
--
-- Schema: cards gains cloze_distractors_en jsonb (NOT NULL DEFAULT '[]').
--   * Deliberately NOT added to _card_sync_content (0017): stored
--     base_version_hash values stay valid, so seeding/refreshing distractors
--     never flags spurious market updates or sync conflicts. User copies do
--     not need the column synced at all — the RPC reads through base_card_id.
--   * Not exposed in _review_card_json / _preview_card_json / update_card:
--     the column is pipeline-owned and only consumed by this RPC, and leaving
--     update_card untouched means user edits can never wipe it.
--
-- RPC: get_minigame_distractors gains p_side = 'cloze' (word-bank cloze):
--   1. the card's own cloze_distractors_en, when non-empty;
--   2. else its base card's (provenance via the no-FK base_card_id), but ONLY
--      while the copy's english_text still matches the base — the option set
--      is curated for that ANSWER (and verified against every stored example
--      sentence, see 0019's examples, which read through under the same
--      answer-match rule), so a copy whose answer was edited falls back;
--   3. both filtered against the card's answer + synonyms_en; if fewer than 2
--      options survive (the app's MIN_MC_DISTRACTORS), fall back to the
--      sibling 'en' pool so the game degrades to pre-0018 behavior instead of
--      breaking.
-- Pre-0018 servers normalize unknown p_side values to 'en', so a newer client
-- sending 'cloze' against an un-migrated database still gets sibling options.
-- ===========================================================================

alter table public.cards
    add column if not exists cloze_distractors_en jsonb not null default '[]'::jsonb;

create or replace function public.get_minigame_distractors(
    p_card_id bigint,
    p_n int default 3,
    p_side text default 'en'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_deck_id bigint;
    v_section text;
    v_pos text;
    v_side text;
    v_pool_side text;
    v_n int;
    v_excluded text[];
    v_curated jsonb;
    v_result jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- Which flavor of distractors: 'es' = sibling spanish_text prompts
    -- (reverse MC); 'cloze' = curated per-card options with sibling-English
    -- fallback (word-bank cloze); anything else = sibling english_text
    -- answers (multiple choice).
    v_side := case
        when lower(coalesce(p_side, 'en')) = 'es' then 'es'
        when lower(coalesce(p_side, 'en')) = 'cloze' then 'cloze'
        else 'en'
    end;
    -- Language column the sibling pool (and exclusion list) works over.
    v_pool_side := case when v_side = 'es' then 'es' else 'en' end;

    -- Clamp the request to a sane range (3–4 tiles is the design target).
    v_n := least(greatest(coalesce(p_n, 3), 1), 8);

    -- Load the anchor card and confirm the caller owns it.
    select d.user_id, c.deck_id, coalesce(c.section_name, d.title), c.part_of_speech
    into v_owner, v_deck_id, v_section, v_pos
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to use this card'; end if;

    -- Values to exclude so a distractor can never restate the correct answer:
    -- the card's own text on the pool side plus its same-side
    -- synonyms/translations (english -> synonyms_en, spanish ->
    -- main_translations_es), normalized (trim + lowercase).
    select coalesce(array_agg(lower(trim(x))), '{}')
    into v_excluded
    from (
        select case when v_pool_side = 'es' then c.spanish_text else c.english_text end as x
        from public.cards c where c.id = p_card_id
        union all
        select jsonb_array_elements_text(
            case when v_pool_side = 'es'
                 then coalesce(c.main_translations_es, '[]'::jsonb)
                 else coalesce(c.synonyms_en, '[]'::jsonb)
            end)
        from public.cards c where c.id = p_card_id
    ) t
    where nullif(trim(x), '') is not null;

    -- ------------------------------------------------------------------
    -- Curated path (word-bank cloze): own options first, else the base
    -- card's while the copy still answers with the same english_text (the
    -- set is curated for that answer across all of the base's example
    -- sentences — 0019 serves those sentences under the same rule). Reading
    -- the base card crosses ownership exactly like the 0017 sync RPCs do —
    -- provenance is established by base_card_id.
    -- ------------------------------------------------------------------
    if v_side = 'cloze' then
        select case
            when jsonb_array_length(coalesce(c.cloze_distractors_en, '[]'::jsonb)) > 0
                then c.cloze_distractors_en
            else (
                select bc.cloze_distractors_en
                from public.cards bc
                where bc.id = c.base_card_id
                  and lower(trim(bc.english_text)) = lower(trim(c.english_text))
                  and jsonb_array_length(coalesce(bc.cloze_distractors_en, '[]'::jsonb)) > 0
            )
        end
        into v_curated
        from public.cards c
        where c.id = p_card_id;

        -- Defensive normalize-filter (a curated option must never restate the
        -- answer or a synonym, even after user edits), then a random sample of
        -- at most v_n so repeat plays vary when 4 options are stored.
        select coalesce(jsonb_agg(opt), '[]'::jsonb)
        into v_result
        from (
            select opt
            from (
                select distinct on (lower(trim(opt))) opt
                from jsonb_array_elements_text(coalesce(v_curated, '[]'::jsonb)) as opt
                where nullif(trim(opt), '') is not null
                  and lower(trim(opt)) <> all (v_excluded)
                order by lower(trim(opt))
            ) uniq
            order by random()
            limit v_n
        ) chosen;

        -- Enough for a fair round (answer + 2 wrong tiles minimum, mirroring
        -- MIN_MC_DISTRACTORS in MinigameHost.jsx)? Otherwise fall through to
        -- the sibling pool below.
        if jsonb_array_length(v_result) >= 2 then
            return v_result;
        end if;
    end if;

    -- ------------------------------------------------------------------
    -- Sibling pool (0013/0014 behavior): candidates from the same deck, one
    -- row per distinct text on the pool side, ordered by preference (same
    -- section first, then same part of speech) with a random tiebreak.
    -- ------------------------------------------------------------------
    with pool as (
        select distinct on (lower(trim(v_text)))
               v_text as answer, section, pos
        from (
            select case when v_pool_side = 'es' then c.spanish_text else c.english_text end as v_text,
                   coalesce(c.section_name, d.title) as section,
                   c.part_of_speech as pos
            from public.cards c
            join public.decks d on d.id = c.deck_id
            where c.deck_id = v_deck_id
              and c.id <> p_card_id
              and c.is_enabled and c.generation_phase = 'refined'
        ) s
        where nullif(trim(v_text), '') is not null
          and lower(trim(v_text)) <> all (v_excluded)
        order by lower(trim(v_text))
    )
    select coalesce(jsonb_agg(answer), '[]'::jsonb)
    into v_result
    from (
        select answer
        from pool
        order by
            (case when section is not distinct from v_section then 0 else 1 end),
            (case when pos is not distinct from v_pos then 0 else 1 end),
            random()
        limit v_n
    ) chosen;

    return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the signature is unchanged so create-or-replace preserves the 0014
-- ACL; re-asserted anyway so this migration stands on its own.
-- ---------------------------------------------------------------------------

revoke execute on function public.get_minigame_distractors(bigint, int, text) from public, anon;
grant execute on function public.get_minigame_distractors(bigint, int, text) to authenticated;

notify pgrst, 'reload schema';
