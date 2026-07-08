-- Market deck sync & change proposals.
--
-- Three capabilities on top of the existing market model (market deck =
-- decks.user_id IS NULL; personal copy = user_id set + base_deck_id):
--
--   1. SYNC DOWN: a personal copy can see what changed in its market deck
--      since it was last synced (added / changed / removed cards, deck info)
--      and selectively apply those updates. Card-level provenance lives in
--      cards.base_card_id (no FK on purpose: a deleted market card must stay
--      detectable as "removed") and cards.base_version_hash — the hash of the
--      market card's content as of the last sync. Comparing three hashes
--      classifies every pair without timestamps:
--        base_hash <> stored_hash                    -> market changed
--        user_hash <> stored_hash                    -> user changed (conflict flag)
--        user content = base content, hashes drifted -> fast-forward silently
--
--   2. PROPOSALS (pull requests): a user who edited cards in their personal
--      copy can propose those edits back to the market deck. A proposal
--      snapshots the proposed content server-side (payload) plus the market
--      card content at proposal time (base_snapshot, for staleness display).
--      The deck maintainer approves (changes are applied to the market deck,
--      which flags updates for every subscriber) or rejects with a note.
--
--   3. OWNERSHIP: decks.owner_id designates the maintainer of a market deck.
--      Unmaintained decks can be claimed; maintainers can transfer ownership
--      by email, edit market cards directly, and review proposals.
--
-- Sync applies are never destructive: a "removed" card is disabled, not
-- deleted, so user progress survives.
--
-- Also fixes a latent clone bug: _duplicate_base_deck_to_user predates
-- mnemonic_en (0006) and synonyms_en (0008) and dropped both when copying.
-- The backfill below deliberately hashes the USER card's current content as
-- the synced baseline, so that pre-existing divergence (mostly those missing
-- mnemonics/synonyms) immediately surfaces as pullable market updates instead
-- of being masked — and never as bogus outgoing proposals that would strip
-- fields from the market deck.

-- The one-time backfill below scans every card; give this migration session
-- generous headroom over the remote's default statement_timeout (the first
-- push attempt was canceled by it).
set statement_timeout = '15min';

-- ===========================================================================
-- 1. Schema changes
-- ===========================================================================

alter table public.decks
    add column if not exists owner_id uuid references auth.users (id) on delete set null;
create index if not exists decks_owner_id_idx on public.decks (owner_id) where owner_id is not null;

alter table public.cards
    add column if not exists base_card_id bigint,
    add column if not exists base_version_hash text,
    add column if not exists content_updated_at timestamptz not null default now();
create index if not exists cards_base_card_id_idx on public.cards (base_card_id) where base_card_id is not null;

-- ===========================================================================
-- 2. Canonical card content + hash
--    The exact field set that sync/proposals move between decks. Excludes
--    per-user state (is_enabled) and generation bookkeeping.
-- ===========================================================================

create or replace function public._card_sync_content(c public.cards)
returns jsonb
language sql
immutable
set search_path = ''
as $$
    select jsonb_build_object(
        'spanish_text', c.spanish_text,
        'english_text', c.english_text,
        'section_name', c.section_name,
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
$$;

create or replace function public._card_content_hash(c public.cards)
returns text
language sql
immutable
set search_path = ''
as $$
    select md5(public._card_sync_content(c)::text)
$$;

-- Bump content_updated_at only when synced content actually changes, so
-- no-op writes (visibility toggles, hash fast-forwards, seed re-runs that
-- rewrite identical values) never flag spurious updates.
create or replace function public._touch_card_content_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if public._card_sync_content(old) is distinct from public._card_sync_content(new) then
        new.content_updated_at := now();
    end if;
    return new;
end;
$$;

drop trigger if exists cards_touch_content_updated_at on public.cards;
create trigger cards_touch_content_updated_at
    before update on public.cards
    for each row execute function public._touch_card_content_updated_at();

-- ===========================================================================
-- 3. Backfill provenance for existing personal copies
--    Match user cards to base cards by normalized spanish_text, only when the
--    match is unambiguous in both directions. base_version_hash is the hash
--    of the USER card's content (see header for why).
--
--    Staged through indexed temp tables: the direct expression join on
--    lower(trim(spanish_text)) has no index support on public.cards, and on
--    the remote the planner ran it as a quadratic nested loop that blew the
--    statement timeout. Materializing the normalized text once and indexing
--    the join key makes the match a plain hash/merge join.
-- ===========================================================================

drop table if exists _bf_user_cards;
create temp table _bf_user_cards as
select c.id as user_card_id, c.deck_id as user_deck_id, d.base_deck_id,
       lower(trim(c.spanish_text)) as norm_text
from public.cards c
join public.decks d on d.id = c.deck_id
join public.decks bd on bd.id = d.base_deck_id and bd.user_id is null
where d.user_id is not null
  and c.base_card_id is null;

drop table if exists _bf_base_cards;
create temp table _bf_base_cards as
select c.id as base_card_id, c.deck_id as base_deck_id,
       lower(trim(c.spanish_text)) as norm_text
from public.cards c
join public.decks d on d.id = c.deck_id
where d.user_id is null;

create index _bf_user_cards_idx on _bf_user_cards (base_deck_id, norm_text);
create index _bf_base_cards_idx on _bf_base_cards (base_deck_id, norm_text);
analyze _bf_user_cards;
analyze _bf_base_cards;

drop table if exists _bf_pairs;
create temp table _bf_pairs as
select u.user_card_id, u.user_deck_id, b.base_card_id
from _bf_user_cards u
join _bf_base_cards b
  on b.base_deck_id = u.base_deck_id and b.norm_text = u.norm_text;

with uniq_user as (
    select user_card_id from _bf_pairs group by user_card_id having count(*) = 1
),
uniq_base as (
    select base_card_id, user_deck_id from _bf_pairs group by base_card_id, user_deck_id having count(*) = 1
)
update public.cards c
set base_card_id = p.base_card_id,
    base_version_hash = public._card_content_hash(c)
from _bf_pairs p
join uniq_user uu on uu.user_card_id = p.user_card_id
join uniq_base ub on ub.base_card_id = p.base_card_id and ub.user_deck_id = p.user_deck_id
where c.id = p.user_card_id;

drop table _bf_pairs;
drop table _bf_base_cards;
drop table _bf_user_cards;

-- ===========================================================================
-- 4. Clone function: copy ALL content fields (fixes the mnemonic/synonym
--    loss) and record provenance + synced baseline.
-- ===========================================================================

create or replace function public._duplicate_base_deck_to_user(p_base_deck_id bigint, p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_base public.decks%rowtype;
    v_new_deck_id bigint;
begin
    select * into v_base from public.decks where id = p_base_deck_id;
    if not found then
        raise exception 'Base deck not found';
    end if;

    insert into public.decks (
        slug, title, description, is_selected_on_home, is_enabled_in_smart_practice,
        language_from, language_to, user_id, base_deck_id
    )
    values (
        v_base.slug || '-user-' || p_user_id::text,
        v_base.title, v_base.description, false, false,
        v_base.language_from, v_base.language_to, p_user_id, p_base_deck_id
    )
    returning id into v_new_deck_id;

    insert into public.cards (
        deck_id, spanish_text, english_text, is_enabled, generation_phase,
        generation_metadata, section_name, part_of_speech, definition_en,
        main_translations_es, collocations, synonyms_en, example_sentence,
        example_es, example_en, mnemonic_en, base_card_id, base_version_hash
    )
    select
        v_new_deck_id, c.spanish_text, c.english_text, c.is_enabled, c.generation_phase,
        c.generation_metadata, c.section_name, c.part_of_speech, c.definition_en,
        c.main_translations_es, c.collocations, c.synonyms_en, c.example_sentence,
        c.example_es, c.example_en, c.mnemonic_en, c.id, public._card_content_hash(c)
    from public.cards c
    where c.deck_id = p_base_deck_id;

    return v_new_deck_id;
end;
$$;

-- ===========================================================================
-- 5. Pending-update count for one personal deck (home badge). Read-only
--    variant of the sync-status classification.
-- ===========================================================================

create or replace function public._deck_pending_sync_count(p_user_deck_id bigint)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_added int; v_changed int; v_removed int; v_meta int := 0;
begin
    select * into v_deck from public.decks where id = p_user_deck_id;
    if not found or v_deck.base_deck_id is null then return 0; end if;

    select * into v_base from public.decks where id = v_deck.base_deck_id and user_id is null;
    if not found then return 0; end if;

    select count(*)::int into v_added
    from public.cards bc
    where bc.deck_id = v_base.id and bc.is_enabled and bc.generation_phase = 'refined'
      and not exists (
          select 1 from public.cards uc
          where uc.deck_id = v_deck.id and uc.base_card_id = bc.id
      );

    select count(*)::int into v_changed
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and bc.is_enabled and bc.generation_phase = 'refined'
      and public._card_content_hash(bc) is distinct from uc.base_version_hash
      and public._card_sync_content(bc) <> public._card_sync_content(uc);

    select count(*)::int into v_removed
    from public.cards uc
    where uc.deck_id = v_deck.id and uc.base_card_id is not null and uc.is_enabled
      and not exists (
          select 1 from public.cards bc
          where bc.id = uc.base_card_id and bc.deck_id = v_base.id
            and bc.is_enabled and bc.generation_phase = 'refined'
      );

    if v_deck.title is distinct from v_base.title
       or v_deck.description is distinct from v_base.description then
        v_meta := 1;
    end if;

    return v_added + v_changed + v_removed + v_meta;
end;
$$;

-- ===========================================================================
-- 6. Sync status + apply
-- ===========================================================================

create or replace function public.get_deck_sync_status(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_added jsonb; v_changed jsonb; v_removed jsonb; v_meta jsonb := null;
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

    -- Fast-forward: user and market ended up with identical content but the
    -- stored baseline drifted (e.g. an approved proposal that mirrors the
    -- proposer's local edit). Not a real difference — re-baseline silently.
    update public.cards uc
    set base_version_hash = public._card_content_hash(bc.*)
    from public.cards bc
    where uc.deck_id = v_deck.id
      and bc.id = uc.base_card_id and bc.deck_id = v_base.id
      and public._card_sync_content(uc.*) = public._card_sync_content(bc.*)
      and uc.base_version_hash is distinct from public._card_content_hash(bc.*);

    select coalesce(jsonb_agg(jsonb_build_object(
        'base_card', public._preview_card_json(bc.id),
        'base_updated_at', bc.content_updated_at
    ) order by bc.section_name nulls last, bc.id), '[]'::jsonb)
    into v_added
    from public.cards bc
    where bc.deck_id = v_base.id and bc.is_enabled and bc.generation_phase = 'refined'
      and not exists (
          select 1 from public.cards uc
          where uc.deck_id = v_deck.id and uc.base_card_id = bc.id
      );

    select coalesce(jsonb_agg(jsonb_build_object(
        'base_card', public._preview_card_json(bc.id),
        'user_card', public._preview_card_json(uc.id),
        'locally_modified', public._card_content_hash(uc.*) is distinct from uc.base_version_hash,
        'base_updated_at', bc.content_updated_at
    ) order by bc.section_name nulls last, bc.id), '[]'::jsonb)
    into v_changed
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and bc.is_enabled and bc.generation_phase = 'refined'
      and public._card_content_hash(bc.*) is distinct from uc.base_version_hash;

    select coalesce(jsonb_agg(jsonb_build_object(
        'user_card', public._preview_card_json(uc.id)
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_removed
    from public.cards uc
    where uc.deck_id = v_deck.id and uc.base_card_id is not null and uc.is_enabled
      and not exists (
          select 1 from public.cards bc
          where bc.id = uc.base_card_id and bc.deck_id = v_base.id
            and bc.is_enabled and bc.generation_phase = 'refined'
      );

    if v_deck.title is distinct from v_base.title
       or v_deck.description is distinct from v_base.description then
        v_meta := jsonb_build_object(
            'mine',   jsonb_build_object('title', v_deck.title, 'description', v_deck.description),
            'market', jsonb_build_object('title', v_base.title, 'description', v_base.description)
        );
    end if;

    return jsonb_build_object(
        'linked', true,
        'deck_id', v_deck.id,
        'base_deck_id', v_base.id,
        'base_deck_title', v_base.title,
        'added', v_added,
        'changed', v_changed,
        'removed', v_removed,
        'deck_meta', v_meta,
        'total_updates', jsonb_array_length(v_added) + jsonb_array_length(v_changed)
            + jsonb_array_length(v_removed) + (case when v_meta is null then 0 else 1 end)
    );
end;
$$;

-- Apply a user-selected subset of pending updates.
-- p_changes: jsonb array of
--   {"type":"add","base_card_id":N} | {"type":"update","base_card_id":N}
--   | {"type":"remove","card_id":N} | {"type":"deck_meta"}
create or replace function public.apply_deck_sync(p_deck_id bigint, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck public.decks%rowtype;
    v_base public.decks%rowtype;
    v_item jsonb;
    v_type text;
    v_bc public.cards%rowtype;
    v_uc public.cards%rowtype;
    v_applied int := 0;
    v_skipped jsonb := '[]'::jsonb;
    v_disabled_any boolean := false;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
        raise exception 'p_changes must be a JSON array';
    end if;

    select * into v_deck from public.decks where id = p_deck_id and user_id = v_uid;
    if not found then raise exception 'Deck not found'; end if;
    if v_deck.base_deck_id is null then raise exception 'Deck is not linked to a market deck'; end if;

    select * into v_base from public.decks where id = v_deck.base_deck_id and user_id is null;
    if not found then raise exception 'Market deck no longer exists'; end if;

    for v_item in select * from jsonb_array_elements(p_changes) loop
        v_type := v_item ->> 'type';

        if v_type = 'add' then
            select * into v_bc from public.cards
            where id = (v_item ->> 'base_card_id')::bigint and deck_id = v_base.id
              and is_enabled and generation_phase = 'refined';
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'market_card_missing');
                continue;
            end if;
            if exists (select 1 from public.cards where deck_id = v_deck.id and base_card_id = v_bc.id) then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'already_present');
                continue;
            end if;
            insert into public.cards (
                deck_id, spanish_text, english_text, is_enabled, generation_phase,
                generation_metadata, section_name, part_of_speech, definition_en,
                main_translations_es, collocations, synonyms_en, example_sentence,
                example_es, example_en, mnemonic_en, base_card_id, base_version_hash
            )
            values (
                v_deck.id, v_bc.spanish_text, v_bc.english_text, true, v_bc.generation_phase,
                v_bc.generation_metadata, v_bc.section_name, v_bc.part_of_speech, v_bc.definition_en,
                v_bc.main_translations_es, v_bc.collocations, v_bc.synonyms_en, v_bc.example_sentence,
                v_bc.example_es, v_bc.example_en, v_bc.mnemonic_en, v_bc.id, public._card_content_hash(v_bc)
            );
            v_applied := v_applied + 1;

        elsif v_type = 'update' then
            select uc.* into v_uc from public.cards uc
            where uc.deck_id = v_deck.id
              and uc.base_card_id = (v_item ->> 'base_card_id')::bigint;
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'card_not_linked');
                continue;
            end if;
            select * into v_bc from public.cards
            where id = v_uc.base_card_id and deck_id = v_base.id
              and is_enabled and generation_phase = 'refined';
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'market_card_missing');
                continue;
            end if;
            update public.cards set
                spanish_text = v_bc.spanish_text,
                english_text = v_bc.english_text,
                section_name = v_bc.section_name,
                part_of_speech = v_bc.part_of_speech,
                definition_en = v_bc.definition_en,
                main_translations_es = v_bc.main_translations_es,
                collocations = v_bc.collocations,
                synonyms_en = v_bc.synonyms_en,
                example_sentence = v_bc.example_sentence,
                example_es = v_bc.example_es,
                example_en = v_bc.example_en,
                mnemonic_en = v_bc.mnemonic_en,
                base_version_hash = public._card_content_hash(v_bc)
            where id = v_uc.id;
            v_applied := v_applied + 1;

        elsif v_type = 'remove' then
            select uc.* into v_uc from public.cards uc
            where uc.id = (v_item ->> 'card_id')::bigint
              and uc.deck_id = v_deck.id and uc.base_card_id is not null;
            if not found then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'card_not_found');
                continue;
            end if;
            if exists (
                select 1 from public.cards bc
                where bc.id = v_uc.base_card_id and bc.deck_id = v_base.id
                  and bc.is_enabled and bc.generation_phase = 'refined'
            ) then
                v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'market_card_still_present');
                continue;
            end if;
            if v_uc.is_enabled then
                update public.cards set is_enabled = false where id = v_uc.id;
                v_disabled_any := true;
            end if;
            v_applied := v_applied + 1;

        elsif v_type = 'deck_meta' then
            update public.decks
            set title = v_base.title, description = v_base.description
            where id = v_deck.id;
            v_applied := v_applied + 1;

        else
            v_skipped := v_skipped || jsonb_build_object('item', v_item, 'reason', 'unknown_type');
        end if;
    end loop;

    if v_disabled_any then
        perform public._clear_pending_practice_cards_for_deck(v_deck.id);
    end if;

    return jsonb_build_object(
        'applied', v_applied,
        'skipped', v_skipped,
        'status', public.get_deck_sync_status(p_deck_id)
    );
end;
$$;

-- ===========================================================================
-- 7. Outgoing changes (candidate proposal items): cards the user edited that
--    still differ from the live market deck.
-- ===========================================================================

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
    v_changes jsonb;
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

    select coalesce(jsonb_agg(jsonb_build_object(
        'user_card', public._preview_card_json(uc.id),
        'base_card', public._preview_card_json(bc.id),
        'already_proposed', exists (
            select 1
            from public.deck_change_proposals pr
            join public.deck_change_proposal_items pi on pi.proposal_id = pr.id
            where pr.market_deck_id = v_base.id and pr.proposer_id = v_uid
              and pr.status = 'open' and pi.base_card_id = bc.id
        )
    ) order by uc.section_name nulls last, uc.id), '[]'::jsonb)
    into v_changes
    from public.cards uc
    join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_base.id
    where uc.deck_id = v_deck.id
      and bc.is_enabled and bc.generation_phase = 'refined'
      and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
      and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*);

    return jsonb_build_object(
        'linked', true,
        'deck_id', v_deck.id,
        'market_deck_id', v_base.id,
        'market_deck_title', v_base.title,
        'changes', v_changes
    );
end;
$$;

-- ===========================================================================
-- 8. Change proposals: tables + RLS
-- ===========================================================================

create table if not exists public.deck_change_proposals (
    id              bigint generated always as identity primary key,
    market_deck_id  bigint not null references public.decks (id) on delete cascade,
    proposer_id     uuid not null references auth.users (id) on delete cascade,
    message         text,
    status          text not null default 'open'
                    check (status in ('open', 'approved', 'rejected', 'withdrawn')),
    created_at      timestamptz not null default now(),
    resolved_at     timestamptz,
    resolved_by     uuid references auth.users (id) on delete set null,
    resolution_note text
);
create index if not exists deck_change_proposals_deck_idx
    on public.deck_change_proposals (market_deck_id, status);
create index if not exists deck_change_proposals_proposer_idx
    on public.deck_change_proposals (proposer_id, status);

create table if not exists public.deck_change_proposal_items (
    id             bigint generated always as identity primary key,
    proposal_id    bigint not null references public.deck_change_proposals (id) on delete cascade,
    change_type    text not null check (change_type in ('edit_card', 'add_card', 'remove_card')),
    base_card_id   bigint,          -- market card targeted (edit/remove); null for add
    source_card_id bigint,          -- proposer's card the item was derived from
    payload        jsonb,           -- proposed content (edit/add); null for remove
    base_snapshot  jsonb            -- market card content at proposal time (edit/remove)
);
create index if not exists deck_change_proposal_items_proposal_idx
    on public.deck_change_proposal_items (proposal_id);

alter table public.deck_change_proposals enable row level security;
alter table public.deck_change_proposal_items enable row level security;

-- Reads: the proposer and the market deck's maintainer. All writes flow
-- through SECURITY DEFINER RPCs; no direct write policies.
create policy "proposals_select_proposer_or_owner" on public.deck_change_proposals
    for select to authenticated using (
        proposer_id = (select auth.uid())
        or exists (
            select 1 from public.decks d
            where d.id = deck_change_proposals.market_deck_id
              and d.owner_id = (select auth.uid())
        )
    );

create policy "proposal_items_select_proposer_or_owner" on public.deck_change_proposal_items
    for select to authenticated using (
        exists (
            select 1 from public.deck_change_proposals p
            where p.id = deck_change_proposal_items.proposal_id
              and (
                  p.proposer_id = (select auth.uid())
                  or exists (
                      select 1 from public.decks d
                      where d.id = p.market_deck_id and d.owner_id = (select auth.uid())
                  )
              )
        )
    );

-- ===========================================================================
-- 9. Proposal JSON shape (shared by list/create/resolve responses)
-- ===========================================================================

create or replace function public._deck_proposal_json(p_proposal_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_result jsonb;
begin
    select jsonb_build_object(
        'proposal_id', p.id,
        'market_deck_id', p.market_deck_id,
        'market_deck_title', d.title,
        'proposer_id', p.proposer_id,
        'proposer_name', coalesce(prof.full_name, 'User'),
        'message', p.message,
        'status', p.status,
        'created_at', p.created_at,
        'resolved_at', p.resolved_at,
        'resolved_by_name', (
            select coalesce(rp.full_name, 'User') from public.profiles rp where rp.id = p.resolved_by
        ),
        'resolution_note', p.resolution_note,
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                'item_id', i.id,
                'change_type', i.change_type,
                'base_card_id', i.base_card_id,
                'payload', i.payload,
                'base_snapshot', i.base_snapshot,
                'current_base', (
                    select public._card_sync_content(bc.*)
                    from public.cards bc
                    where bc.id = i.base_card_id and bc.deck_id = p.market_deck_id
                ),
                'is_stale', (
                    i.base_snapshot is not null
                    and i.base_snapshot is distinct from (
                        select public._card_sync_content(bc.*)
                        from public.cards bc
                        where bc.id = i.base_card_id and bc.deck_id = p.market_deck_id
                    )
                )
            ) order by i.id)
            from public.deck_change_proposal_items i
            where i.proposal_id = p.id
        ), '[]'::jsonb)
    )
    into v_result
    from public.deck_change_proposals p
    join public.decks d on d.id = p.market_deck_id
    left join public.profiles prof on prof.id = p.proposer_id
    where p.id = p_proposal_id;

    return v_result;
end;
$$;

-- ===========================================================================
-- 10. Proposal RPCs
-- ===========================================================================

-- Submit selected cards from MY copy of a market deck as a proposal. The
-- server derives every item from the caller's real cards — clients never send
-- content payloads, so nothing can be forged.
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
            -- Edit of an existing market card; skip when it is a no-op.
            if public._card_sync_content(v_uc) = public._card_sync_content(v_bc) then
                continue;
            end if;
            insert into public.deck_change_proposal_items
                (proposal_id, change_type, base_card_id, source_card_id, payload, base_snapshot)
            values
                (v_proposal_id, 'edit_card', v_bc.id, v_uc.id,
                 public._card_sync_content(v_uc), public._card_sync_content(v_bc));
        else
            -- No market counterpart (personal addition or market card deleted).
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

-- Proposals I should review (decks I maintain) and proposals I submitted.
create or replace function public.list_deck_proposals()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_to_review jsonb;
    v_mine jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select coalesce(jsonb_agg(public._deck_proposal_json(p.id)
        order by (p.status = 'open') desc, p.created_at desc), '[]'::jsonb)
    into v_to_review
    from public.deck_change_proposals p
    join public.decks d on d.id = p.market_deck_id
    where d.owner_id = v_uid and p.proposer_id <> v_uid;

    select coalesce(jsonb_agg(public._deck_proposal_json(p.id)
        order by (p.status = 'open') desc, p.created_at desc), '[]'::jsonb)
    into v_mine
    from public.deck_change_proposals p
    where p.proposer_id = v_uid;

    return jsonb_build_object('to_review', v_to_review, 'mine', v_mine);
end;
$$;

-- Approve or reject an open proposal on a deck I maintain. Approval applies
-- every item to the market deck; items whose target vanished are skipped and
-- reported. Content updates bump content_updated_at via the trigger, which
-- flags "updates available" for every subscriber.
create or replace function public.resolve_deck_change_proposal(
    p_proposal_id bigint,
    p_action text,
    p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_proposal public.deck_change_proposals%rowtype;
    v_owner uuid;
    v_item record;
    v_bc public.cards%rowtype;
    v_new_card_id bigint;
    v_applied int := 0;
    v_skipped jsonb := '[]'::jsonb;
    v_now timestamptz := now();
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_action not in ('approve', 'reject') then raise exception 'Invalid action'; end if;

    select * into v_proposal from public.deck_change_proposals
    where id = p_proposal_id for update;
    if not found then raise exception 'Proposal not found'; end if;
    if v_proposal.status <> 'open' then raise exception 'Proposal is no longer open'; end if;

    select owner_id into v_owner from public.decks
    where id = v_proposal.market_deck_id and user_id is null;
    if not found then raise exception 'Market deck no longer exists'; end if;
    if v_owner is distinct from v_uid then
        raise exception 'Only the deck maintainer can review proposals';
    end if;

    if p_action = 'approve' then
        for v_item in
            select * from public.deck_change_proposal_items
            where proposal_id = v_proposal.id order by id
        loop
            if v_item.change_type = 'edit_card' then
                select * into v_bc from public.cards
                where id = v_item.base_card_id and deck_id = v_proposal.market_deck_id;
                if not found then
                    v_skipped := v_skipped || jsonb_build_object('item_id', v_item.id, 'reason', 'market_card_missing');
                    continue;
                end if;
                update public.cards set
                    spanish_text = coalesce(nullif(trim(v_item.payload ->> 'spanish_text'), ''), spanish_text),
                    english_text = coalesce(nullif(trim(v_item.payload ->> 'english_text'), ''), english_text),
                    section_name = nullif(trim(coalesce(v_item.payload ->> 'section_name', '')), ''),
                    part_of_speech = nullif(trim(coalesce(v_item.payload ->> 'part_of_speech', '')), ''),
                    definition_en = nullif(trim(coalesce(v_item.payload ->> 'definition_en', '')), ''),
                    main_translations_es = coalesce(v_item.payload -> 'main_translations_es', '[]'::jsonb),
                    collocations = coalesce(v_item.payload -> 'collocations', '[]'::jsonb),
                    synonyms_en = coalesce(v_item.payload -> 'synonyms_en', '[]'::jsonb),
                    example_sentence = nullif(trim(coalesce(v_item.payload ->> 'example_sentence', '')), ''),
                    example_es = nullif(trim(coalesce(v_item.payload ->> 'example_es', '')), ''),
                    example_en = nullif(trim(coalesce(v_item.payload ->> 'example_en', '')), ''),
                    mnemonic_en = nullif(trim(coalesce(v_item.payload ->> 'mnemonic_en', '')), '')
                where id = v_bc.id;
                v_applied := v_applied + 1;

            elsif v_item.change_type = 'add_card' then
                if nullif(trim(coalesce(v_item.payload ->> 'spanish_text', '')), '') is null
                   or nullif(trim(coalesce(v_item.payload ->> 'english_text', '')), '') is null then
                    v_skipped := v_skipped || jsonb_build_object('item_id', v_item.id, 'reason', 'invalid_payload');
                    continue;
                end if;
                insert into public.cards (
                    deck_id, spanish_text, english_text, is_enabled, generation_phase,
                    generation_metadata, section_name, part_of_speech, definition_en,
                    main_translations_es, collocations, synonyms_en, example_sentence,
                    example_es, example_en, mnemonic_en
                )
                values (
                    v_proposal.market_deck_id,
                    trim(v_item.payload ->> 'spanish_text'),
                    trim(v_item.payload ->> 'english_text'),
                    true, 'refined', '{}'::jsonb,
                    nullif(trim(coalesce(v_item.payload ->> 'section_name', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'part_of_speech', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'definition_en', '')), ''),
                    coalesce(v_item.payload -> 'main_translations_es', '[]'::jsonb),
                    coalesce(v_item.payload -> 'collocations', '[]'::jsonb),
                    coalesce(v_item.payload -> 'synonyms_en', '[]'::jsonb),
                    nullif(trim(coalesce(v_item.payload ->> 'example_sentence', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'example_es', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'example_en', '')), ''),
                    nullif(trim(coalesce(v_item.payload ->> 'mnemonic_en', '')), '')
                )
                returning id into v_new_card_id;
                -- Link the proposer's own card to the market card it spawned,
                -- so their copy tracks it instead of re-appearing as "added".
                if v_item.source_card_id is not null then
                    update public.cards uc
                    set base_card_id = v_new_card_id,
                        base_version_hash = (
                            select public._card_content_hash(nc.*)
                            from public.cards nc where nc.id = v_new_card_id
                        )
                    from public.decks ud
                    where uc.id = v_item.source_card_id
                      and uc.base_card_id is null
                      and ud.id = uc.deck_id
                      and ud.user_id = v_proposal.proposer_id
                      and ud.base_deck_id = v_proposal.market_deck_id;
                end if;
                v_applied := v_applied + 1;

            elsif v_item.change_type = 'remove_card' then
                update public.cards set is_enabled = false
                where id = v_item.base_card_id and deck_id = v_proposal.market_deck_id;
                if found then
                    v_applied := v_applied + 1;
                else
                    v_skipped := v_skipped || jsonb_build_object('item_id', v_item.id, 'reason', 'market_card_missing');
                end if;
            end if;
        end loop;
    end if;

    update public.deck_change_proposals set
        status = case when p_action = 'approve' then 'approved' else 'rejected' end,
        resolved_at = v_now,
        resolved_by = v_uid,
        resolution_note = nullif(trim(coalesce(p_note, '')), '')
    where id = v_proposal.id;

    return jsonb_build_object(
        'proposal', public._deck_proposal_json(v_proposal.id),
        'applied', v_applied,
        'skipped', v_skipped
    );
end;
$$;

-- Withdraw my own open proposal.
create or replace function public.withdraw_deck_change_proposal(p_proposal_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    update public.deck_change_proposals
    set status = 'withdrawn', resolved_at = now(), resolved_by = v_uid
    where id = p_proposal_id and proposer_id = v_uid and status = 'open';
    if not found then
        raise exception 'Proposal not found or no longer open';
    end if;

    return public._deck_proposal_json(p_proposal_id);
end;
$$;

-- ===========================================================================
-- 11. Ownership RPCs
-- ===========================================================================

-- Become the maintainer of an unmaintained market deck (first come, first serve).
create or replace function public.claim_market_deck(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select owner_id into v_owner from public.decks where id = p_deck_id and user_id is null;
    if not found then raise exception 'Market deck not found'; end if;

    update public.decks set owner_id = v_uid
    where id = p_deck_id and owner_id is null;
    if not found then
        raise exception 'This deck already has a maintainer';
    end if;

    return jsonb_build_object(
        'deck_id', p_deck_id,
        'owner_id', v_uid,
        'owner_name', (select coalesce(full_name, 'User') from public.profiles where id = v_uid)
    );
end;
$$;

-- Hand a market deck I maintain to another registered user, by email.
create or replace function public.transfer_market_deck_ownership(p_deck_id bigint, p_new_owner_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_new_owner uuid;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select owner_id into v_owner from public.decks where id = p_deck_id and user_id is null;
    if not found then raise exception 'Market deck not found'; end if;
    if v_owner is distinct from v_uid then
        raise exception 'Only the current maintainer can transfer this deck';
    end if;

    select id into v_new_owner from auth.users
    where lower(email) = lower(trim(coalesce(p_new_owner_email, '')))
    limit 1;
    if v_new_owner is null then
        raise exception 'No account found for that email';
    end if;
    if v_new_owner = v_uid then
        raise exception 'You already maintain this deck';
    end if;

    update public.decks set owner_id = v_new_owner where id = p_deck_id;

    return jsonb_build_object(
        'deck_id', p_deck_id,
        'owner_id', v_new_owner,
        'owner_name', (select coalesce(full_name, 'User') from public.profiles where id = v_new_owner)
    );
end;
$$;

-- ===========================================================================
-- 12. Card JSON: expose provenance (additive key; all existing consumers keep
--     working).
-- ===========================================================================

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
        'base_card_id', c.base_card_id
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

-- ===========================================================================
-- 13. Deck queries: surface sync + ownership info
-- ===========================================================================

create or replace function public.get_home_decks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_result jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_result
    from (
        select
            d.id, d.slug, d.title, d.description,
            d.is_selected_on_home, d.is_enabled_in_smart_practice,
            d.base_deck_id,
            (case when d.base_deck_id is not null
                  then public._deck_pending_sync_count(d.id)
                  else 0 end) as updates_available,
            count(c.id)::int as total_cards,
            coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::int as reviewed_cards,
            coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)::int as known_cards,
            coalesce(sum(case when cp.last_result = 'unknown' then 1 else 0 end), 0)::int as unknown_cards,
            case when count(c.id) > 0
                 then coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::float / count(c.id)
                 else 0 end as completion_ratio,
            (count(c.id) > 0 and coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0) = count(c.id)) as is_completed
        from public.decks d
        left join public.cards c on c.deck_id = d.id and c.is_enabled and c.generation_phase = 'refined'
        left join public.card_progress cp on cp.card_id = c.id
        where d.is_selected_on_home and d.user_id = v_uid
        group by d.id
    ) t;

    return v_result;
end;
$$;

create or replace function public.get_market_decks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_result jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb)
    into v_result
    from (
        select
            d.id, d.slug, d.title, d.description,
            coalesce(ud.is_selected_on_home, false) as is_selected_on_home,
            coalesce(ud.is_enabled_in_smart_practice, d.is_enabled_in_smart_practice) as is_enabled_in_smart_practice,
            d.owner_id,
            (select coalesce(p.full_name, 'User') from public.profiles p where p.id = d.owner_id) as owner_name,
            coalesce(d.owner_id = v_uid, false) as is_owner,
            (case when d.owner_id = v_uid then (
                select count(*)::int from public.deck_change_proposals pr
                where pr.market_deck_id = d.id and pr.status = 'open' and pr.proposer_id <> v_uid
            ) else 0 end) as open_proposals,
            (select count(*)::int from public.deck_change_proposals pr
             where pr.market_deck_id = d.id and pr.status = 'open' and pr.proposer_id = v_uid) as my_open_proposals,
            (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and bc.generation_phase = 'refined')::int as total_cards,
            coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::int as reviewed_cards,
            coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)::int as known_cards,
            coalesce(sum(case when cp.last_result = 'unknown' then 1 else 0 end), 0)::int as unknown_cards,
            case when (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and bc.generation_phase = 'refined') > 0
                 then coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::float
                      / (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and bc.generation_phase = 'refined')
                 else 0 end as completion_ratio,
            ((select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and bc.generation_phase = 'refined') > 0
                 and coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)
                     = (select count(*) from public.cards bc where bc.deck_id = d.id and bc.is_enabled and bc.generation_phase = 'refined')) as is_completed
        from public.decks d
        left join public.decks ud on ud.base_deck_id = d.id and ud.user_id = v_uid
        left join public.cards uc on uc.deck_id = ud.id and uc.is_enabled and uc.generation_phase = 'refined'
        left join public.card_progress cp on cp.card_id = uc.id
        where d.user_id is null
        group by d.id, ud.is_selected_on_home, ud.is_enabled_in_smart_practice, d.is_enabled_in_smart_practice
    ) t;

    return v_result;
end;
$$;

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
            select count(*)::int into v_outgoing
            from public.cards uc
            join public.cards bc on bc.id = uc.base_card_id and bc.deck_id = v_deck.base_deck_id
            where uc.deck_id = v_deck.id
              and bc.is_enabled and bc.generation_phase = 'refined'
              and public._card_content_hash(uc.*) is distinct from uc.base_version_hash
              and public._card_sync_content(uc.*) <> public._card_sync_content(bc.*);
        end if;
    end if;

    if v_is_owner then
        select count(*)::int into v_open_proposals
        from public.deck_change_proposals pr
        where pr.market_deck_id = v_deck.id and pr.status = 'open' and pr.proposer_id <> v_uid;
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
        'updates_available', v_updates,
        'outgoing_changes', v_outgoing,
        'open_proposals', v_open_proposals
    );
end;
$$;

-- ===========================================================================
-- 14. Card mutations: maintainers may edit market decks directly
-- ===========================================================================

create or replace function public.update_card_visibility(p_card_id bigint, p_is_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_deck_id bigint;
    v_owner uuid;
    v_maintainer uuid;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select c.deck_id, d.user_id, d.owner_id into v_deck_id, v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
    end if;

    update public.cards set is_enabled = p_is_enabled where id = p_card_id;

    if not p_is_enabled then
        perform public._clear_pending_practice_cards_for_deck(v_deck_id);
    end if;

    return jsonb_build_object('card_id', p_card_id, 'deck_id', v_deck_id, 'is_enabled', p_is_enabled);
end;
$$;

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
    v_maintainer uuid;
    v_prompt text;
    v_answer text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select d.user_id, d.owner_id into v_owner, v_maintainer
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if not (coalesce(v_owner = v_uid, false)
            or (v_owner is null and coalesce(v_maintainer = v_uid, false))) then
        raise exception 'Not authorized to modify this card';
    end if;

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
-- 15. Grants: lock down helpers; new RPCs are authenticated-only (0005 pattern)
-- ===========================================================================

revoke execute on function public._card_sync_content(public.cards) from anon, authenticated, public;
revoke execute on function public._card_content_hash(public.cards) from anon, authenticated, public;
revoke execute on function public._touch_card_content_updated_at() from anon, authenticated, public;
revoke execute on function public._deck_pending_sync_count(bigint) from anon, authenticated, public;
revoke execute on function public._deck_proposal_json(bigint) from anon, authenticated, public;

do $$
declare
    fn text;
    fns text[] := array[
        'public.get_deck_sync_status(bigint)',
        'public.apply_deck_sync(bigint, jsonb)',
        'public.get_deck_outgoing_changes(bigint)',
        'public.create_deck_change_proposal(bigint, text, bigint[])',
        'public.list_deck_proposals()',
        'public.resolve_deck_change_proposal(bigint, text, text)',
        'public.withdraw_deck_change_proposal(bigint)',
        'public.claim_market_deck(bigint)',
        'public.transfer_market_deck_ownership(bigint, text)'
    ];
begin
    foreach fn in array fns loop
        execute format('revoke execute on function %s from public, anon;', fn);
        execute format('grant execute on function %s to authenticated;', fn);
    end loop;
end $$;

reset statement_timeout;

notify pgrst, 'reload schema';
