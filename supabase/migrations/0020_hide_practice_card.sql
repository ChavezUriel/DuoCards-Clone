-- ===========================================================================
-- Hide the current smart-practice card from the deck, mid-session.
--
-- Wired to the "Hide card" button in the practice card-details modal — the "i"
-- overlay that every modality (classic flashcard + all per-card minigames) shows
-- once the answer is revealed. It flips the card to is_enabled = false, exactly
-- like the deck-management toggle (update_card_visibility), so the card never
-- resurfaces here or in a future session (the snapshot's next-card query already
-- filters c.is_enabled).
--
-- The difference from update_card_visibility is the blast radius. That function
-- clears the WHOLE deck's pending queue across every session — correct for the
-- deck manager, but it would gut a running practice session down to nothing when
-- you hide a single word. This RPC instead removes ONLY the current card from the
-- running session, leaving the rest of the queue (and its order) intact so the
-- learner keeps going. It mirrors skip_smart_practice_card's guards and, like
-- skip, is never gradeable and never undoable.
-- ===========================================================================

create or replace function public.hide_smart_practice_card(p_session_id bigint, p_card_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_status text;
    v_entry_card_id bigint;
    v_owner uuid;
    v_now timestamptz := now();
    v_remaining int;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select status into v_status
    from public.practice_sessions where id = p_session_id and user_id = v_uid;
    if not found then raise exception 'Smart practice session not found'; end if;
    if v_status <> 'active' then raise exception 'Smart practice session is no longer active'; end if;

    -- The current card is the front of the queue; verify it matches so we only ever
    -- hide the card the learner is actually looking at (mirrors skip / submit).
    select card_id into v_entry_card_id
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

    -- Hiding flips a column on the card itself, so confirm the caller owns the
    -- card's deck (mirrors update_card_visibility) — not merely that it appears in
    -- their session.
    select d.user_id into v_owner
    from public.cards c join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to modify this card'; end if;

    update public.cards set is_enabled = false where id = p_card_id;

    -- Drop ONLY this card from the running session (not the whole deck's queue), so
    -- the remaining cards keep their order and the summary counts stay honest.
    delete from public.practice_session_cards
    where session_id = p_session_id and card_id = p_card_id and status = 'pending';

    -- Finish the session if that emptied the queue; otherwise just clear the undo
    -- marker. Hiding is not a graded action and cannot be undone, so any pending
    -- one-step undo is dropped either way (can_undo then reports nothing to undo).
    select count(*) into v_remaining
    from public.practice_session_cards
    where session_id = p_session_id and status = 'pending';

    if v_remaining = 0 then
        update public.practice_sessions
        set status = 'completed', completed_at = v_now, last_review_snapshot = null, updated_at = v_now
        where id = p_session_id;
    else
        update public.practice_sessions
        set last_review_snapshot = null, updated_at = v_now
        where id = p_session_id;
    end if;

    return public._practice_session_snapshot(p_session_id, v_uid);
end;
$$;

-- New RPC is authenticated-only, matching the other smart-practice mutations.
revoke execute on function public.hide_smart_practice_card(bigint, bigint) from public, anon;
grant execute on function public.hide_smart_practice_card(bigint, bigint) to authenticated;

notify pgrst, 'reload schema';
