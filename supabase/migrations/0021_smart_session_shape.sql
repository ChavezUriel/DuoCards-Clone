-- ===========================================================================
-- 0021: Drop the manual "interleaving intensity" knob; derive the session
--       shape automatically from the learner's card status.
--
-- The old flow made the user pick low / medium / high interleaving on the home
-- "Play Auto" card, and that value was carried all the way into the queue
-- builder as p_interleaving_intensity. Manual tuning is exactly the decision the
-- scheduler is better placed to make, and the pedagogy research points to a
-- deterministic rule rather than a preference:
--
--   * Cognitive-load hypothesis / "undesirable difficulty" — novices without a
--     minimum base of established knowledge are overloaded by early interleaving;
--     an initial *blocked* run of new material is needed for declarative
--     knowledge to form (Hwang et al. 2025, Language Learning; Chen et al. 2021,
--     Educational Psychology Review).
--   * Spacing effect — due reviews should be cleared before they decay, so a
--     heavy review backlog takes priority over mixing in new cards.
--   * Discriminative-contrast hypothesis — once a learner has an established
--     base and a balanced load, fully interleaving new + review sharpens
--     item discrimination and long-term retention (Rohrer & Taylor).
--
-- So the shape is now chosen by rule from three counts over the user's home,
-- smart-practice-enabled decks:
--   v_new     = unmastered material still available
--   v_learned = mastered cards (the "established base")
--   v_due     = mastered cards due now
--
--   mode <> 'mixed'                 -> shape = null   (one kind; nothing to mix)
--   v_learned < 30 (novice base)    -> 'front_loaded' (new block first, then reviews)
--   v_due > v_new * 2 (backlog)     -> 'spread'       (new woven evenly; reviews dominate)
--   otherwise (established, balanced)-> 'interleaved'  (full shuffle)
--
-- The interleaving_intensity column and the p_interleaving_intensity parameter
-- are removed; a nullable session_shape column records the auto-chosen shape so
-- the client can surface it read-only. _choose_session_mode (the mode ruleset)
-- is unchanged.
-- ===========================================================================

-- The old 4-arg signature (…, p_interleaving_intensity, p_focus_mode) can't be
-- CREATE OR REPLACE'd into the 3-arg one; drop it, then recreate below.
drop function if exists public.start_smart_practice_session(int, int, text, text);

-- Swap the storage column: interleaving_intensity (user knob) -> session_shape
-- (auto-derived, nullable because single-kind sessions have no shape).
alter table public.practice_sessions
    drop column if exists interleaving_intensity;
alter table public.practice_sessions
    add column if not exists session_shape text
        check (session_shape in ('front_loaded', 'spread', 'interleaved'));

-- ---------------------------------------------------------------------------
-- Session builder: mode ruleset + auto session-shape ruleset.
-- ---------------------------------------------------------------------------

create or replace function public.start_smart_practice_session(
    p_new_block_size int default 7,
    p_review_batch_size int default 30,
    p_focus_mode text default 'auto'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_session_id bigint;
    v_mode text;
    v_now timestamptz := now();
    v_count int;
    v_new_limit int;
    v_review_limit int;
    v_new_total int;
    v_learned_total int;
    v_due_total int;
    v_shape text;      -- stored/displayed; null for single-kind sessions
    v_strategy text;   -- always set; drives the queue sort_key
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- validate settings (mirrors SmartPracticeSettings)
    if p_new_block_size < 5 or p_new_block_size > 12 then raise exception 'new_block_size out of range'; end if;
    if p_review_batch_size < 10 or p_review_batch_size > 50 then raise exception 'review_batch_size out of range'; end if;
    if p_focus_mode not in ('auto', 'new_material', 'review') then raise exception 'invalid focus_mode'; end if;

    -- A start is always explicit: retire whatever round was left hanging so
    -- the requested mode/settings take effect and the queue is rebuilt from
    -- live scheduling state.
    update public.practice_sessions
    set status = 'abandoned', updated_at = v_now
    where user_id = v_uid and status = 'active';

    v_mode := public._choose_session_mode(v_uid, p_focus_mode);
    v_new_limit := case when v_mode = 'review' then 0 else p_new_block_size end;
    v_review_limit := case when v_mode = 'new_material' then 0 else p_review_batch_size end;

    -- Card-status counts over the user's home, smart-practice-enabled decks;
    -- these feed the auto session-shape ruleset below.
    select
        coalesce(sum(case when cp.initial_mastered_at is null or cp.card_id is null then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is not null then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is not null
                           and coalesce(cp.due_at, v_now) <= v_now then 1 else 0 end), 0)
    into v_new_total, v_learned_total, v_due_total
    from public.cards c
    join public.decks d on d.id = c.deck_id
    left join public.card_progress cp on cp.card_id = c.id
    where c.is_enabled and c.generation_phase = 'refined'
      and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = v_uid;

    -- Auto session-shape ruleset (see migration header for the pedagogy).
    -- Keep the 30-card base threshold in sync with the frontend home descriptor
    -- (frontend/src/pages/HomePage.jsx, LEARNED_BASE_THRESHOLD).
    if v_mode <> 'mixed' then
        v_shape := null;                            -- single kind: nothing to interleave
    elsif v_learned_total < 30 then
        v_shape := 'front_loaded';                  -- novice base: block new first
    elsif v_due_total > v_new_total * 2 then
        v_shape := 'spread';                        -- review backlog dominates
    else
        v_shape := 'interleaved';                   -- established, balanced: full shuffle
    end if;
    -- The sort_key always needs a value; for a single-kind session the ordering
    -- is irrelevant, and 'front_loaded' preserves the pick order (random new /
    -- due-first review), so default to it.
    v_strategy := coalesce(v_shape, 'front_loaded');

    insert into public.practice_sessions (
        status, scope, mode, focus_mode, new_block_size, review_batch_size,
        session_shape, user_id, created_at, updated_at
    )
    values (
        'active', 'global', v_mode, p_focus_mode, p_new_block_size, p_review_batch_size,
        v_shape, v_uid, v_now, v_now
    )
    returning id into v_session_id;

    -- Pick new cards at random; pick reviews due-first ordered by predicted
    -- recall (lowest retrievability = most at risk of being forgotten),
    -- topping up with the soonest-due cards when not enough are due yet.
    -- Shape: front_loaded = new block first, then reviews (blocked);
    -- spread = new cards spread evenly through the review queue;
    -- interleaved = everything shuffled together.
    insert into public.practice_session_cards (session_id, card_id, queue_position, card_kind)
    select v_session_id, merged.card_id,
           (row_number() over (order by merged.sort_key, merged.card_id))::int - 1,
           merged.card_kind
    from (
        select np.card_id, 'new'::text as card_kind,
               case v_strategy
                   when 'front_loaded' then np.rn::double precision
                   when 'interleaved' then random() * 1000
                   else ((np.rn - 0.5) / greatest(np.cnt, 1)) * 1000
               end as sort_key
        from (
            select picked.card_id,
                   row_number() over () as rn,
                   count(*) over () as cnt
            from (
                select c.id as card_id
                from public.cards c
                join public.decks d on d.id = c.deck_id
                left join public.card_progress cp on cp.card_id = c.id
                where c.is_enabled and c.generation_phase = 'refined'
                  and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = v_uid
                  and (cp.initial_mastered_at is null or cp.card_id is null)
                order by random()
                limit v_new_limit
            ) picked
        ) np

        union all

        select rp.card_id, 'review'::text as card_kind,
               case v_strategy
                   when 'front_loaded' then 1000000 + rp.rn::double precision
                   when 'interleaved' then random() * 1000
                   else ((rp.rn - 0.5) / greatest(rp.cnt, 1)) * 1000
               end as sort_key
        from (
            select picked.card_id,
                   picked.rn,
                   count(*) over () as cnt
            from (
                select c.id as card_id,
                       row_number() over (order by
                           case when coalesce(cp.due_at, v_now) <= v_now then 0 else 1 end,
                           case when cp.stability is not null and cp.last_reviewed_at is not null
                                then power(
                                    1 + (19.0 / 81.0)
                                        * (greatest(0, extract(epoch from (v_now - cp.last_reviewed_at)) / 86400.0)
                                           / cp.stability),
                                    -0.5)
                                else 0 end asc,
                           coalesce(cp.due_at, v_now) asc,
                           c.id asc
                       ) as rn
                from public.cards c
                join public.decks d on d.id = c.deck_id
                join public.card_progress cp on cp.card_id = c.id
                where c.is_enabled and c.generation_phase = 'refined'
                  and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = v_uid
                  and cp.initial_mastered_at is not null
                order by rn asc
                limit v_review_limit
            ) picked
        ) rp
    ) merged;

    get diagnostics v_count = row_count;
    if v_count = 0 then
        update public.practice_sessions
        set status = 'completed', completed_at = v_now, updated_at = v_now
        where id = v_session_id;
        raise exception 'No cards are available for smart practice';
    end if;

    return public._practice_session_snapshot(v_session_id, v_uid);
end;
$$;

-- ---------------------------------------------------------------------------
-- Snapshot: emit session_shape in place of interleaving_intensity. Straight
-- copy of the 0013 snapshot with the one field swapped.
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
        ps.new_block_size, ps.review_batch_size, ps.session_shape,
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
            'session_shape', v_summary.session_shape,
            'can_undo', v_summary.can_undo
        ),
        'current_card', v_current
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the rebuilt builder needs its ACL re-granted (drop cleared it);
-- the snapshot is replaced in place so its ACL carries over.
-- ---------------------------------------------------------------------------

revoke execute on function public.start_smart_practice_session(int, int, text) from public, anon;
grant execute on function public.start_smart_practice_session(int, int, text) to authenticated;

notify pgrst, 'reload schema';
