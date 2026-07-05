-- ===========================================================================
-- 0014: Minigames Phase 5 — Spanish distractors for Reverse multiple choice.
--
-- See docs/minigames.md §4 (#5), §9 (Phase 5). Reverse MC shows the English answer
-- and asks the learner to pick the matching Spanish prompt from sibling prompt_es
-- tiles, so it needs SPANISH distractors. get_minigame_distractors (0013) only
-- returned English (english_text) siblings.
--
-- This extends it with a `p_side` parameter:
--   * 'en' (default) — sibling english_text answers, excluding the card's answer and
--                      its English synonyms (synonyms_en). Unchanged behavior; the
--                      two-argument callers (multiple choice / word-bank cloze) keep
--                      working because p_side defaults to 'en'.
--   * 'es'          — sibling spanish_text prompts, excluding the card's prompt and
--                      its Spanish translations (main_translations_es).
--
-- Purely additive to recognition (Tier B) games: the graded path is untouched, and
-- reverse MC is off by default, so nothing changes until a user enables it.
-- ===========================================================================

-- Drop the old two-argument signature so there is a single canonical function; the
-- new one still accepts two-argument calls via the p_side default.
drop function if exists public.get_minigame_distractors(bigint, int);

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
    v_n int;
    v_excluded text[];
    v_result jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- Which language of sibling to return: 'es' picks spanish_text prompts (reverse
    -- MC); anything else picks english_text answers (multiple choice / word-bank).
    v_side := case when lower(coalesce(p_side, 'en')) = 'es' then 'es' else 'en' end;

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

    -- Values to exclude so a distractor can never restate the correct answer: the
    -- card's own text on the chosen side plus its same-side synonyms/translations
    -- (english -> synonyms_en, spanish -> main_translations_es), normalized
    -- (trim + lowercase) so equivalent spellings are all filtered out.
    select coalesce(array_agg(lower(trim(x))), '{}')
    into v_excluded
    from (
        select case when v_side = 'es' then c.spanish_text else c.english_text end as x
        from public.cards c where c.id = p_card_id
        union all
        select jsonb_array_elements_text(
            case when v_side = 'es'
                 then coalesce(c.main_translations_es, '[]'::jsonb)
                 else coalesce(c.synonyms_en, '[]'::jsonb)
            end)
        from public.cards c where c.id = p_card_id
    ) t
    where nullif(trim(x), '') is not null;

    -- Candidate siblings from the same deck, one row per distinct text on the chosen
    -- side, then ordered by preference (same section first, then same part of speech)
    -- with a random tiebreak so repeated plays vary the options.
    with pool as (
        select distinct on (lower(trim(v_text)))
               v_text as answer, section, pos
        from (
            select case when v_side = 'es' then c.spanish_text else c.english_text end as v_text,
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
-- Grants: authenticated-only, matching the 0013 function's ACL (the old signature
-- was dropped above, so re-grant on the new one).
-- ---------------------------------------------------------------------------

revoke execute on function public.get_minigame_distractors(bigint, int, text) from public, anon;
grant execute on function public.get_minigame_distractors(bigint, int, text) to authenticated;

notify pgrst, 'reload schema';
