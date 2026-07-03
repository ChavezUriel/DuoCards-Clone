-- ===========================================================================
-- 0012: One-step "undo last review" for both review flows.
--
-- A misclick on known / didn't-know should be reversible: the user presses a
-- back button, the last card returns, and they re-answer as if the wrong swipe
-- never happened. Every review overwrites the card's FSRS memory state in place
-- (_apply_card_progress upserts stability/difficulty/due_at/state/reps/lapses)
-- and smart practice also moves the card in its queue, so a correct undo cannot
-- just apply the opposite grade -- that would stack a second review on top of
-- the first and corrupt scheduling. Instead each review snapshots the exact
-- pre-review state, and undo restores it verbatim, then clears the snapshot
-- (single level -- only the most recent review can be undone).
--
--   * Per-deck review (submit_review):       snapshot -> public.review_undo
--                                            (one row per user: the last review).
--   * Smart practice  (submit_smart_practice_review):
--       snapshot -> practice_sessions.last_review_snapshot, and undo also
--       reverses the queue move (requeue / complete) and reactivates the
--       session when that review had finished it.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

alter table public.practice_sessions
    add column if not exists last_review_snapshot jsonb;

create table if not exists public.review_undo (
    user_id              uuid primary key references auth.users (id) on delete cascade,
    card_id              bigint not null references public.cards (id) on delete cascade,
    card_progress_before jsonb,   -- card_progress row before the review; null if none existed
    created_at           timestamptz not null default now()
);

-- Only the SECURITY DEFINER RPCs below touch this table. RLS enabled with no
-- policy denies all direct client access; the definer functions bypass RLS.
alter table public.review_undo enable row level security;

-- ---------------------------------------------------------------------------
-- Shared restore helper
-- ---------------------------------------------------------------------------

-- Restore a card_progress row from a snapshot taken before a review. p_before
-- is the row as jsonb; SQL NULL or JSON 'null' means no row existed (a card's
-- first-ever review), in which case the row is removed again.
create or replace function public._restore_card_progress(p_card_id bigint, p_before jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_before is null or jsonb_typeof(p_before) = 'null' then
        delete from public.card_progress where card_id = p_card_id;
        return;
    end if;

    insert into public.card_progress (
        card_id, user_id, known_count, unknown_count, known_streak,
        last_result, last_reviewed_at, initial_mastered_at,
        stability, difficulty, due_at, state, reps, lapses
    )
    values (
        p_card_id,
        (p_before ->> 'user_id')::uuid,
        (p_before ->> 'known_count')::int,
        (p_before ->> 'unknown_count')::int,
        (p_before ->> 'known_streak')::int,
        p_before ->> 'last_result',
        (p_before ->> 'last_reviewed_at')::timestamptz,
        (p_before ->> 'initial_mastered_at')::timestamptz,
        (p_before ->> 'stability')::double precision,
        (p_before ->> 'difficulty')::double precision,
        (p_before ->> 'due_at')::timestamptz,
        coalesce(p_before ->> 'state', 'new'),
        (p_before ->> 'reps')::int,
        (p_before ->> 'lapses')::int
    )
    on conflict (card_id) do update set
        user_id = excluded.user_id,
        known_count = excluded.known_count,
        unknown_count = excluded.unknown_count,
        known_streak = excluded.known_streak,
        last_result = excluded.last_result,
        last_reviewed_at = excluded.last_reviewed_at,
        initial_mastered_at = excluded.initial_mastered_at,
        stability = excluded.stability,
        difficulty = excluded.difficulty,
        due_at = excluded.due_at,
        state = excluded.state,
        reps = excluded.reps,
        lapses = excluded.lapses;
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-deck review: capture snapshot on submit, restore on undo
-- ---------------------------------------------------------------------------

create or replace function public.submit_review(p_card_id bigint, p_result text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_progress jsonb;
    v_cp_before jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_result not in ('known', 'unknown') then raise exception 'Invalid result'; end if;

    select d.user_id into v_owner
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id and c.is_enabled and c.generation_phase = 'refined';

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to review this card'; end if;

    -- Snapshot the pre-review progress so this submit can be undone one step.
    select to_jsonb(cp) into v_cp_before
    from public.card_progress cp where cp.card_id = p_card_id;

    v_progress := public._apply_card_progress(p_card_id, v_uid, p_result);

    insert into public.review_undo (user_id, card_id, card_progress_before, created_at)
    values (v_uid, p_card_id, v_cp_before, now())
    on conflict (user_id) do update set
        card_id = excluded.card_id,
        card_progress_before = excluded.card_progress_before,
        created_at = excluded.created_at;

    return jsonb_build_object(
        'card_id', p_card_id,
        'result', p_result,
        'reviewed_at', v_progress ->> 'last_reviewed_at',
        'known_count', (v_progress ->> 'known_count')::int,
        'unknown_count', (v_progress ->> 'unknown_count')::int
    );
end;
$$;

-- Undo the last per-deck review: restore card_progress and hand the card back.
create or replace function public.undo_review()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_card_id bigint;
    v_before jsonb;
    v_owner uuid;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select card_id, card_progress_before into v_card_id, v_before
    from public.review_undo where user_id = v_uid;
    if not found then raise exception 'Nothing to undo'; end if;

    select d.user_id into v_owner
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = v_card_id;
    if not found or v_owner is distinct from v_uid then
        delete from public.review_undo where user_id = v_uid;
        raise exception 'Not authorized to undo this review';
    end if;

    perform public._restore_card_progress(v_card_id, v_before);
    delete from public.review_undo where user_id = v_uid;

    return public._review_card_json(v_card_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Smart practice: expose can_undo, capture snapshot on submit, restore on undo
-- ---------------------------------------------------------------------------

-- Session snapshot (0006 shape) plus a can_undo flag driven by the stored
-- last_review_snapshot, so the client knows when to offer the back button.
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

    select psc.card_id, psc.card_kind into v_card
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
        v_current := public._review_card_json(v_card.card_id)
            || jsonb_build_object('card_kind', v_card.card_kind);
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

create or replace function public.submit_smart_practice_review(p_session_id bigint, p_card_id bigint, p_result text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_status text;
    v_entry_id bigint; v_entry_card_id bigint; v_entry_kind text;
    v_prev_queue_pos int; v_prev_status text; v_prev_times int;
    v_prev_presented_at timestamptz; v_prev_result text;
    v_cp_before jsonb;
    v_progress jsonb;
    v_should_repeat boolean;
    v_now timestamptz := now();
    v_next_pos int;
    v_pending int;
    v_snapshot jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_result not in ('known', 'unknown') then raise exception 'Invalid result'; end if;

    select status into v_status
    from public.practice_sessions where id = p_session_id and user_id = v_uid;
    if not found then raise exception 'Smart practice session not found'; end if;
    if v_status <> 'active' then raise exception 'Smart practice session is no longer active'; end if;

    -- Capture the current card entry (and its mutable queue fields) before the move.
    select id, card_id, card_kind, queue_position, status, times_presented, last_presented_at, last_result
    into v_entry_id, v_entry_card_id, v_entry_kind, v_prev_queue_pos, v_prev_status, v_prev_times, v_prev_presented_at, v_prev_result
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

    -- Snapshot the pre-review FSRS state alongside the queue state above.
    select to_jsonb(cp) into v_cp_before
    from public.card_progress cp where cp.card_id = p_card_id;

    v_progress := public._apply_card_progress(p_card_id, v_uid, p_result);

    -- New cards keep cycling until the initial in-session mastery streak;
    -- review cards only come back on a miss.
    if v_entry_kind = 'new' then
        v_should_repeat := (v_progress ->> 'initial_mastered_at') is null;
    else
        v_should_repeat := (p_result = 'unknown');
    end if;

    if v_should_repeat then
        select coalesce(max(queue_position), -1) + 1 into v_next_pos
        from public.practice_session_cards where session_id = p_session_id;
        update public.practice_session_cards
        set queue_position = v_next_pos, times_presented = times_presented + 1,
            last_presented_at = v_now, last_result = p_result
        where id = v_entry_id;
    else
        update public.practice_session_cards
        set status = 'completed', times_presented = times_presented + 1,
            last_presented_at = v_now, last_result = p_result
        where id = v_entry_id;
    end if;

    select count(*)::int into v_pending
    from public.practice_session_cards where session_id = p_session_id and status = 'pending';

    if v_pending = 0 then
        update public.practice_sessions set status = 'completed', completed_at = v_now, updated_at = v_now where id = p_session_id;
    else
        update public.practice_sessions set updated_at = v_now where id = p_session_id;
    end if;

    -- Record the one-step undo snapshot (overwrites any previous one).
    update public.practice_sessions
    set last_review_snapshot = jsonb_build_object(
        'card_id', p_card_id,
        'card_progress', v_cp_before,
        'session_card', jsonb_build_object(
            'queue_position', v_prev_queue_pos,
            'status', v_prev_status,
            'times_presented', v_prev_times,
            'last_presented_at', v_prev_presented_at,
            'last_result', v_prev_result
        )
    )
    where id = p_session_id;

    v_snapshot := public._practice_session_snapshot(p_session_id, v_uid);
    return jsonb_build_object(
        'session', v_snapshot,
        'review_feedback', jsonb_build_object(
            'card_id', p_card_id,
            'result', p_result,
            'state', v_progress ->> 'state',
            'interval_days', (v_progress ->> 'interval_days')::int,
            'due_at', v_progress ->> 'due_at',
            'repeats_in_session', v_should_repeat
        )
    );
end;
$$;

-- Undo the last smart-practice review: restore FSRS state, put the card back in
-- the queue, reactivate the session if that review had finished it.
create or replace function public.undo_smart_practice_review(p_session_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_snapshot jsonb;
    v_card_id bigint;
    v_sc jsonb;
    v_now timestamptz := now();
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select last_review_snapshot into v_snapshot
    from public.practice_sessions
    where id = p_session_id and user_id = v_uid;
    if not found then raise exception 'Smart practice session not found'; end if;
    if v_snapshot is null then raise exception 'Nothing to undo'; end if;

    v_card_id := (v_snapshot ->> 'card_id')::bigint;
    v_sc := v_snapshot -> 'session_card';

    -- Restore FSRS memory state to exactly what it was before the review.
    perform public._restore_card_progress(v_card_id, v_snapshot -> 'card_progress');

    -- Put the queued card back where it was (undo the requeue-or-complete move).
    update public.practice_session_cards set
        queue_position = (v_sc ->> 'queue_position')::int,
        status = v_sc ->> 'status',
        times_presented = (v_sc ->> 'times_presented')::int,
        last_presented_at = (v_sc ->> 'last_presented_at')::timestamptz,
        last_result = v_sc ->> 'last_result'
    where session_id = p_session_id and card_id = v_card_id;

    -- Reactivate the session (the review may have finished it) and drop the snapshot.
    update public.practice_sessions set
        status = 'active', completed_at = null,
        last_review_snapshot = null, updated_at = v_now
    where id = p_session_id;

    return public._practice_session_snapshot(p_session_id, v_uid);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: helpers stay server-only; the new undo RPCs are authenticated-only.
-- (submit_review / submit_smart_practice_review / _practice_session_snapshot
--  are replaced in place, so their existing ACLs carry over.)
-- ---------------------------------------------------------------------------

revoke execute on function public._restore_card_progress(bigint, jsonb) from public, anon, authenticated;

revoke execute on function public.undo_review() from public, anon;
grant execute on function public.undo_review() to authenticated;

revoke execute on function public.undo_smart_practice_review(bigint) from public, anon;
grant execute on function public.undo_smart_practice_review(bigint) to authenticated;

notify pgrst, 'reload schema';
