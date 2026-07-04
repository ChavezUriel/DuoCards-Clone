-- ===========================================================================
-- 0013: Minigames Phase 2 — snapshot fields + Tier-B "Multiple choice" support.
--
-- See docs/minigames.md §2.4, §5.3, §8.3, §9 (Phase 2). Three small backend
-- affordances so the client can run recognition games without ever corrupting
-- the FSRS schedule:
--
--   1. Expose `times_presented` / `last_result` on current_card so the client
--      can tell first exposure vs consolidating vs just-lapsed (§2.4/§6.2).
--   2. get_minigame_distractors(card_id, n) — plausible wrong English answers
--      for multiple-choice tiles, from the same deck/section (§8.3).
--   3. skip_smart_practice_card(session_id, card_id) — advance the current
--      pending card WITHOUT grading it, for a Tier-B recognition win (§5.3).
--      A recognition win must never award a `known`, advance the 2-streak, or
--      touch stability/difficulty/due_at.
--
-- Nothing here changes the graded path: submit_smart_practice_review and
-- _apply_card_progress are untouched, so Tier-A games and the classic swipe
-- behave exactly as before.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Snapshot: add times_presented + last_result to current_card.
--
-- Straight copy of the 0012 snapshot (keeps the can_undo flag) with two extra
-- columns selected from practice_session_cards and merged onto current_card.
-- ---------------------------------------------------------------------------

create or replace function public._practice_session_snapshot(p_session_id bigint, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_summary record;
    v_card record;
    v_current jsonb := null;
begin
    select
        ps.id as session_id, ps.status, ps.mode, ps.focus_mode,
        ps.new_block_size, ps.review_batch_size, ps.interleaving_intensity,
        (ps.last_review_snapshot is not null) as can_undo,
        count(psc.card_id)::int as total_cards,
        coalesce(sum(case when psc.status = 'completed' then 1 else 0 end), 0)::int as completed_cards,
        coalesce(sum(case when psc.status = 'pending' then 1 else 0 end), 0)::int as remaining_cards,
        coalesce(sum(case when psc.status = 'pending' and psc.card_kind = 'new' then 1 else 0 end), 0)::int as remaining_new,
        coalesce(sum(case when psc.status = 'pending' and psc.card_kind = 'review' then 1 else 0 end), 0)::int as remaining_review
    into v_summary
    from public.practice_sessions ps
    left join public.practice_session_cards psc on psc.session_id = ps.id
    where ps.id = p_session_id and ps.user_id = p_user_id
    group by ps.id;

    if not found then
        return null;
    end if;

    select psc.card_id, psc.card_kind, psc.times_presented, psc.last_result into v_card
    from public.practice_session_cards psc
    join public.cards c on c.id = psc.card_id
    join public.decks d on d.id = c.deck_id
    where psc.session_id = p_session_id
      and psc.status = 'pending'
      and c.is_enabled and c.generation_phase = 'refined'
      and d.is_selected_on_home and d.is_enabled_in_smart_practice
    order by psc.queue_position asc
    limit 1;

    if found then
        -- card_kind (new vs review) plus the two session-scoped signals the
        -- minigame orchestrator needs to distinguish first exposure /
        -- consolidating / just-lapsed (docs/minigames.md §6.2).
        v_current := public._review_card_json(v_card.card_id)
            || jsonb_build_object(
                'card_kind', v_card.card_kind,
                'times_presented', v_card.times_presented,
                'last_result', v_card.last_result
            );
    end if;

    return jsonb_build_object(
        'summary', jsonb_build_object(
            'session_id', v_summary.session_id,
            'status', v_summary.status,
            'mode', v_summary.mode,
            'focus_mode', v_summary.focus_mode,
            'total_cards', v_summary.total_cards,
            'completed_cards', v_summary.completed_cards,
            'remaining_cards', v_summary.remaining_cards,
            'remaining_new', v_summary.remaining_new,
            'remaining_review', v_summary.remaining_review,
            'new_block_size', v_summary.new_block_size,
            'review_batch_size', v_summary.review_batch_size,
            'interleaving_intensity', v_summary.interleaving_intensity,
            'can_undo', v_summary.can_undo
        ),
        'current_card', v_current
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Distractors for recognition games (docs/minigames.md §8.3).
--
-- Returns a jsonb array of up to N sibling English answers from the same deck,
-- de-duplicated case-insensitively and ordered to prefer the same section, then
-- the same part_of_speech. The card's own answer and its English synonyms are
-- excluded so a distractor can never restate the correct answer. The frontend
-- shuffles these together with the real answer to build the option tiles.
-- ---------------------------------------------------------------------------

create or replace function public.get_minigame_distractors(p_card_id bigint, p_n int default 3)
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
    v_answer text;
    v_n int;
    v_excluded text[];
    v_result jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- Clamp the request to a sane range (3–4 tiles is the design target).
    v_n := least(greatest(coalesce(p_n, 3), 1), 8);

    -- Load the anchor card and confirm the caller owns it.
    select d.user_id, c.deck_id, coalesce(c.section_name, d.title),
           c.part_of_speech, c.english_text
    into v_owner, v_deck_id, v_section, v_pos, v_answer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to use this card'; end if;

    -- Values to exclude: the answer plus every English synonym, normalized
    -- (trim + lowercase) so equivalent spellings are all filtered out.
    select coalesce(array_agg(lower(trim(x))), '{}')
    into v_excluded
    from (
        select v_answer as x
        union all
        select jsonb_array_elements_text(coalesce(c.synonyms_en, '[]'::jsonb))
        from public.cards c where c.id = p_card_id
    ) t
    where nullif(trim(x), '') is not null;

    -- Candidate siblings from the same deck, one row per distinct answer text,
    -- then ordered by preference (same section first, then same part of speech)
    -- with a random tiebreak so repeated plays vary the options.
    with pool as (
        select distinct on (lower(trim(c.english_text)))
               c.english_text as answer,
               coalesce(c.section_name, d.title) as section,
               c.part_of_speech as pos
        from public.cards c
        join public.decks d on d.id = c.deck_id
        where c.deck_id = v_deck_id
          and c.id <> p_card_id
          and c.is_enabled and c.generation_phase = 'refined'
          and nullif(trim(c.english_text), '') is not null
          and lower(trim(c.english_text)) <> all (v_excluded)
        order by lower(trim(c.english_text))
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
-- 3. Skip / advance-without-grade (docs/minigames.md §5.3).
--
-- A Tier-B recognition win must move the card on WITHOUT touching card_progress:
-- no _apply_card_progress, so stability / difficulty / due_at / lapses and the
-- 2-in-a-row streak that trips initial_mastered_at are all untouched. The card
-- is recycled to the back of the queue for a later genuine free-recall rep.
--
-- last_result is cleared to null: the snapshot's last_result is what the client
-- keys a recognition game off, so nulling it guarantees the very next
-- presentation of this card is free recall (classic / typing), never a second
-- recognition game back-to-back. That keeps graduation reachable (guardrail
-- §3.3) — a card can only leave the session, or trip its 2-streak, on real
-- free recall.
--
-- Returns a fresh session snapshot, same shape as submit_smart_practice_review's
-- `session`.
-- ---------------------------------------------------------------------------

create or replace function public.skip_smart_practice_card(p_session_id bigint, p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_status text;
    v_entry_id bigint;
    v_entry_card_id bigint;
    v_now timestamptz := now();
    v_next_pos int;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select status into v_status
    from public.practice_sessions where id = p_session_id and user_id = v_uid;
    if not found then raise exception 'Smart practice session not found'; end if;
    if v_status <> 'active' then raise exception 'Smart practice session is no longer active'; end if;

    -- The current pending card is the front of the queue; verify it matches.
    select id, card_id into v_entry_id, v_entry_card_id
    from public.practice_session_cards
    where session_id = p_session_id and status = 'pending'
    order by queue_position asc limit 1;

    if not found then
        update public.practice_sessions set status = 'completed', completed_at = v_now, updated_at = v_now where id = p_session_id;
        raise exception 'Smart practice session is already complete';
    end if;
    if v_entry_card_id <> p_card_id then
        raise exception 'Submitted card does not match the active smart practice card';
    end if;

    -- Recycle to the back of the queue. Bump times_presented (it WAS shown), but
    -- never call _apply_card_progress and clear last_result (see header). A skip
    -- always re-queues (never completes), so the pending count is unchanged and
    -- the session cannot finish here.
    select coalesce(max(queue_position), -1) + 1 into v_next_pos
    from public.practice_session_cards where session_id = p_session_id;

    update public.practice_session_cards
    set queue_position = v_next_pos,
        times_presented = times_presented + 1,
        last_presented_at = v_now,
        last_result = null
    where id = v_entry_id;

    -- A skip is not a graded action and cannot itself be undone; drop any pending
    -- one-step undo marker so can_undo correctly reports there is nothing to undo.
    update public.practice_sessions
    set last_review_snapshot = null, updated_at = v_now
    where id = p_session_id;

    return public._practice_session_snapshot(p_session_id, v_uid);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: new RPCs are authenticated-only. _practice_session_snapshot is
-- replaced in place, so its existing ACL carries over.
-- ---------------------------------------------------------------------------

revoke execute on function public.get_minigame_distractors(bigint, int) from public, anon;
grant execute on function public.get_minigame_distractors(bigint, int) to authenticated;

revoke execute on function public.skip_smart_practice_card(bigint, bigint) from public, anon;
grant execute on function public.skip_smart_practice_card(bigint, bigint) to authenticated;

notify pgrst, 'reload schema';
