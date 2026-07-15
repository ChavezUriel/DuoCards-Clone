-- ===========================================================================
-- Bulk card visibility for the deck explorer's "Hide/Show all" overflow menu.
--
-- The per-card update_card_visibility already does this one id at a time, but
-- the explorer's bulk action would fire one round trip per card — hundreds for
-- a large deck, each clearing the deck's practice queue again, with no way to
-- keep the batch atomic when one card fails halfway through.
--
-- Scope comes from the caller as an explicit id list rather than a deck id,
-- because the menu acts on the CURRENTLY FILTERED rows ("Hide 12 matching
-- cards"), not necessarily the whole deck. The explorer only ever lists
-- generation_phase = 'refined' cards, so that filter rides along in the ids.
--
-- Authorization mirrors update_card_visibility exactly (deck owner, or the
-- maintainer of an unowned market deck), evaluated per card. One unauthorized
-- or missing id aborts the whole batch — a partial bulk hide would leave the
-- deck in a state the learner never asked for and can't easily undo.
-- ===========================================================================

create or replace function public.update_cards_visibility(p_card_ids bigint[], p_is_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_ids bigint[];
    v_found int;
    v_authorized int;
    v_updated int;
    v_deck_id bigint;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- Collapse duplicates up front so the found-count check below compares like
    -- with like.
    select coalesce(array_agg(distinct id), '{}'::bigint[])
    into v_ids
    from unnest(coalesce(p_card_ids, '{}'::bigint[])) as t(id);

    if cardinality(v_ids) = 0 then
        return jsonb_build_object('updated_count', 0, 'is_enabled', p_is_enabled, 'card_ids', '[]'::jsonb);
    end if;

    select
        count(*),
        count(*) filter (
            where coalesce(d.user_id = v_uid, false)
               or (d.user_id is null and coalesce(d.owner_id = v_uid, false))
        )
    into v_found, v_authorized
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = any(v_ids);

    if v_found <> cardinality(v_ids) then raise exception 'Card not found'; end if;
    if v_authorized <> v_found then raise exception 'Not authorized to modify this card'; end if;

    -- Only touch rows that actually change, so updated_count reports the real
    -- delta and an all-visible deck's "Show all" is a no-op.
    update public.cards
    set is_enabled = p_is_enabled
    where id = any(v_ids) and is_enabled is distinct from p_is_enabled;
    get diagnostics v_updated = row_count;

    -- Hiding a card that a session already queued would hand the learner a card
    -- the deck no longer contains, so drop each affected deck's pending queue --
    -- same blast radius as the per-card function, just deduplicated to one pass
    -- per deck instead of one per card.
    if not p_is_enabled and v_updated > 0 then
        for v_deck_id in
            select distinct c.deck_id from public.cards c where c.id = any(v_ids)
        loop
            perform public._clear_pending_practice_cards_for_deck(v_deck_id);
        end loop;
    end if;

    return jsonb_build_object(
        'updated_count', v_updated,
        'is_enabled', p_is_enabled,
        'card_ids', to_jsonb(v_ids)
    );
end;
$$;

-- New RPC is authenticated-only, matching the other card mutations.
revoke execute on function public.update_cards_visibility(bigint[], boolean) from public, anon;
grant execute on function public.update_cards_visibility(bigint[], boolean) to authenticated;

notify pgrst, 'reload schema';
