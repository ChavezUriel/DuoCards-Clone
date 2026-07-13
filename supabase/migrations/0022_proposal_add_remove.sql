-- ===========================================================================
-- 0022  Proposals: detect card additions and removals
-- ===========================================================================
-- Migration 0017 gave proposals ("PRs" against a market deck) three item types
-- — edit_card / add_card / remove_card — and resolve_deck_change_proposal
-- already applies all three. But the *detection* side only ever surfaced edits:
-- get_deck_outgoing_changes joined every user card to its market original, so a
-- card with no counterpart (a personal addition) or a market card the user hid
-- in their copy (a removal) never appeared as a proposable change.
--
-- This migration teaches the outgoing-change detection — and the outgoing count
-- baked into get_deck_preview — to recognize both, keyed entirely on the user's
-- own cards so create_deck_change_proposal can keep taking p_user_card_ids:
--   * addition  = enabled card in a linked deck with base_card_id IS NULL
--   * removal   = disabled (hidden) card whose market original is still live
-- Nothing about the wire shape of a proposal item changes; only which items get
-- generated. All three functions are replaced in place (create or replace keeps
-- their existing grants).
--
-- get_deck_preview additionally gains `user_copy_deck_id`: when the caller is
-- viewing a market deck, this is their linked personal copy (if any) — the
-- mirror of `base_deck_id`, so the explorer can cross-link both directions.

-- ---------------------------------------------------------------------------
-- 1. Outgoing changes now returns a unified `changes` array whose rows carry a
--    `kind` ('edit' | 'add' | 'remove'). `base_card` is null for additions.
-- ---------------------------------------------------------------------------
create or replace function public.get_deck_outgoing_changes(p_deck_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_edits jsonb;
    v_adds jsonb;
    v_removes jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_deck from public.decks where id = p_deck_id and user_id = v_uid;
    if not found then raise exception 'Deck not found'; end if;

    if v_deck.base_deck_id is null then
        return jsonb_build_object('linked', false);
    end if;

    select * into v_base from public.decks where id = v_deck.base_deck_id and user_id is null;
    if not found then
        return jsonb_build_object('linked', false);
    end if;

    -- Edits: an enabled card whose content diverged from its market original.
    -- (A hidden card, even if also edited, is treated as a removal below.)
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'edit',
        'user_card', public._preview_card_json(uc.id),
        'base_card', public._preview_card_json(bc.id),
        'already_proposed', exists (
            select 1
            from public.deck_change_proposals pr
            join public.deck_change_proposal_items pi on pi.proposal_id = pr.id
            where pr.market_deck_id = v_base.id and pr.proposer_id = v_uid
              and pr.status = 'open' and pi.change_type = 'edit_card' and pi.base_card_id = bc.id
        )
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_edits
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and uc.is_enabled
      and bc.is_enabled and bc.generation_phase = 'refined'
      and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
      and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*);

    -- Additions: an enabled card in this linked deck with no market counterpart.
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'add',
        'user_card', public._preview_card_json(uc.id),
        'base_card', null,
        'already_proposed', exists (
            select 1
            from public.deck_change_proposals pr
            join public.deck_change_proposal_items pi on pi.proposal_id = pr.id
            where pr.market_deck_id = v_base.id and pr.proposer_id = v_uid
              and pr.status = 'open' and pi.change_type = 'add_card' and pi.source_card_id = uc.id
        )
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_adds
    from public.cards uc
    where uc.deck_id = v_deck.id
      and uc.base_card_id is null
      and uc.is_enabled
      and uc.generation_phase = 'refined';

    -- Removals: a market card you hid in your copy while it is still live in the
    -- market — a signal to propose deleting it for everyone.
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'remove',
        'user_card', public._preview_card_json(uc.id),
        'base_card', public._preview_card_json(bc.id),
        'already_proposed', exists (
            select 1
            from public.deck_change_proposals pr
            join public.deck_change_proposal_items pi on pi.proposal_id = pr.id
            where pr.market_deck_id = v_base.id and pr.proposer_id = v_uid
              and pr.status = 'open' and pi.change_type = 'remove_card' and pi.base_card_id = bc.id
        )
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_removes
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and not uc.is_enabled
      and bc.is_enabled and bc.generation_phase = 'refined';

    return jsonb_build_object(
        'linked', true,
        'deck_id', v_deck.id,
        'market_deck_id', v_base.id,
        'market_deck_title', v_base.title,
        'changes', (v_edits || v_adds || v_removes)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Creating a proposal now derives the item type from the user card's state:
--    hidden + linked -> remove_card, unlinked -> add_card, otherwise edit_card.
-- ---------------------------------------------------------------------------
create or replace function public.create_deck_change_proposal(
    p_market_deck_id bigint,
    p_message text,
    p_user_card_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_base public.decks%rowtype;
    v_card_ids bigint[];
    v_card_id bigint;
    v_uc public.cards%rowtype;
    v_bc public.cards%rowtype;
    v_proposal_id bigint;
    v_items int := 0;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_base from public.decks where id = p_market_deck_id and user_id is null;
    if not found then raise exception 'Market deck not found'; end if;

    if p_user_card_ids is null or array_length(p_user_card_ids, 1) is null then
        raise exception 'No cards selected';
    end if;
    if array_length(p_user_card_ids, 1) > 200 then
        raise exception 'Too many cards in one proposal (max 200)';
    end if;

    insert into public.deck_change_proposals (market_deck_id, proposer_id, message)
    values (p_market_deck_id, v_uid, nullif(trim(coalesce(p_message, '')), ''))
    returning id into v_proposal_id;

    select array_agg(distinct c) into v_card_ids from unnest(p_user_card_ids) c;

    foreach v_card_id in array v_card_ids loop
        select uc.* into v_uc
        from public.cards uc
        join public.decks ud on ud.id = uc.deck_id
        where uc.id = v_card_id and ud.user_id = v_uid and ud.base_deck_id = p_market_deck_id;
        if not found then
            raise exception 'Card % is not part of your copy of this market deck', v_card_id;
        end if;

        v_bc := null;
        if v_uc.base_card_id is not null then
            select * into v_bc from public.cards
            where id = v_uc.base_card_id and deck_id = p_market_deck_id;
        end if;

        if v_bc.id is not null then
            if not v_uc.is_enabled then
                -- You hid a market card: propose removing it. Skip when the
                -- market card is already gone/disabled (nothing left to remove).
                if not (v_bc.is_enabled and v_bc.generation_phase = 'refined') then
                    continue;
                end if;
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'remove_card', v_bc.id, v_uc.id,
                     null, public._card_sync_content(v_bc));
            elsif public._card_sync_content(v_uc) = public._card_sync_content(v_bc) then
                -- Enabled and identical to the market card: nothing to propose.
                continue;
            else
                insert into public.deck_change_proposal_items
                    (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
                values
                    (v_proposal_id, 'edit_card', v_bc.id, v_uc.id,
                     public._card_sync_content(v_uc), public._card_sync_content(v_bc));
            end if;
        else
            -- No market counterpart. A hidden personal card has nothing to add.
            if not v_uc.is_enabled then
                continue;
            end if;
            insert into public.deck_change_proposal_items
                (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
            values
                (v_proposal_id, 'add_card', null, v_uc.id, public._card_sync_content(v_uc), null);
        end if;
        v_items := v_items + 1;
    end loop;

    if v_items = 0 then
        raise exception 'Selected cards do not differ from the market deck';
    end if;

    return public._deck_proposal_json(v_proposal_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The outgoing-change count on the deck preview (which drives the "Propose
--    to market (N)" button) now counts edits + additions + removals.
-- ---------------------------------------------------------------------------
create or replace function public.get_deck_preview(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_cards jsonb;
    v_is_market boolean;
    v_is_owner boolean;
    v_base_available boolean := false;
    v_updates int := 0;
    v_outgoing int := 0;
    v_open_proposals int := 0;
    v_user_copy_deck_id bigint := null;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_deck
    from public.decks
    where id = p_deck_id and (user_id = v_uid or user_id is null);
    if not found then
        raise exception 'Deck not found or not on home';
    end if;

    v_is_market := v_deck.user_id is null;
    v_is_owner := v_is_market and coalesce(v_deck.owner_id = v_uid, false);

    if not v_is_market and v_deck.base_deck_id is not null then
        v_base_available := exists (
            select 1 from public.decks b where b.id = v_deck.base_deck_id and b.user_id is null
        );
        if v_base_available then
            v_updates := public._deck_pending_sync_count(v_deck.id);
            select
                (select count(*) from public.cards uc
                   join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_deck.base_deck_id
                   where uc.deck_id = v_deck.id and uc.is_enabled
                     and bc.is_enabled and bc.generation_phase = 'refined'
                     and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
                     and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*))
              + (select count(*) from public.cards uc
                   where uc.deck_id = v_deck.id and uc.base_card_id is null
                     and uc.is_enabled and uc.generation_phase = 'refined')
              + (select count(*) from public.cards uc
                   join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_deck.base_deck_id
                   where uc.deck_id = v_deck.id and not uc.is_enabled
                     and bc.is_enabled and bc.generation_phase = 'refined')
            into v_outgoing;
        end if;
    end if;

    if v_is_owner then
        select count(*)::int into v_open_proposals
        from public.deck_change_proposals pr
        where pr.market_deck_id = v_deck.id and pr.status = 'open' and pr.proposer_id <> v_uid;
    end if;

    -- When viewing a market deck, surface my linked personal copy (if any) so
    -- the explorer can offer a jump to it — the mirror of base_deck_id.
    if v_is_market then
        select id into v_user_copy_deck_id
        from public.decks
        where user_id = v_uid and base_deck_id = v_deck.id
        order by id
        limit 1;
    end if;

    select coalesce(jsonb_agg(public._preview_card_json(s.id) order by s.section_name asc, s.id asc), '[]'::jsonb)
    into v_cards
    from (
        select c.id, coalesce(c.section_name, d.title) as section_name
        from public.cards c
        join public.decks d on d.id = c.deck_id
        where c.deck_id = p_deck_id and c.generation_phase = 'refined'
    ) s;

    return jsonb_build_object(
        'deck_id', v_deck.id,
        'deck_title', v_deck.title,
        'deck_description', v_deck.description,
        'total_cards', jsonb_array_length(v_cards),
        'cards', v_cards,
        'is_market', v_is_market,
        'is_owner', v_is_owner,
        'owner_id', v_deck.owner_id,
        'owner_name', (select coalesce(p.full_name, 'User') from public.profiles p where p.id = v_deck.owner_id),
        'can_edit', coalesce(v_deck.user_id = v_uid, false) or v_is_owner,
        'base_deck_id', v_deck.base_deck_id,
        'base_deck_available', v_base_available,
        'user_copy_deck_id', v_user_copy_deck_id,
        'updates_available', v_updates,
        'outgoing_changes', v_outgoing,
        'open_proposals', v_open_proposals
    );
end;
$$;
