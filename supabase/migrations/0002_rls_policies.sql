-- Row-Level Security for all public tables.
-- All policies scope to the authenticated user via auth.uid().
-- Writes flow through SECURITY DEFINER RPCs; these policies are defense-in-depth
-- and also make safe direct reads possible from the client.

alter table public.profiles              enable row level security;
alter table public.decks                 enable row level security;
alter table public.cards                 enable row level security;
alter table public.card_progress         enable row level security;
alter table public.practice_sessions     enable row level security;
alter table public.practice_session_cards enable row level security;

-- profiles -------------------------------------------------------------------
create policy "profiles_select_own" on public.profiles
    for select to authenticated using (id = (select auth.uid()));
create policy "profiles_update_own" on public.profiles
    for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- decks: own decks + global starter decks (user_id IS NULL) are readable -----
create policy "decks_select_own_or_global" on public.decks
    for select to authenticated using (user_id = (select auth.uid()) or user_id is null);
create policy "decks_insert_own" on public.decks
    for insert to authenticated with check (user_id = (select auth.uid()));
create policy "decks_update_own" on public.decks
    for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "decks_delete_own" on public.decks
    for delete to authenticated using (user_id = (select auth.uid()));

-- cards: readable if the parent deck is mine or global; writable if mine ------
create policy "cards_select_own_or_global" on public.cards
    for select to authenticated using (
        exists (
            select 1 from public.decks d
            where d.id = cards.deck_id and (d.user_id = (select auth.uid()) or d.user_id is null)
        )
    );
create policy "cards_insert_own" on public.cards
    for insert to authenticated with check (
        exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = (select auth.uid()))
    );
create policy "cards_update_own" on public.cards
    for update to authenticated using (
        exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = (select auth.uid()))
    ) with check (
        exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = (select auth.uid()))
    );
create policy "cards_delete_own" on public.cards
    for delete to authenticated using (
        exists (select 1 from public.decks d where d.id = cards.deck_id and d.user_id = (select auth.uid()))
    );

-- card_progress --------------------------------------------------------------
create policy "card_progress_all_own" on public.card_progress
    for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- practice_sessions ----------------------------------------------------------
create policy "practice_sessions_all_own" on public.practice_sessions
    for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- practice_session_cards: scoped through the parent session ------------------
create policy "practice_session_cards_all_own" on public.practice_session_cards
    for all to authenticated using (
        exists (select 1 from public.practice_sessions ps where ps.id = practice_session_cards.session_id and ps.user_id = (select auth.uid()))
    ) with check (
        exists (select 1 from public.practice_sessions ps where ps.id = practice_session_cards.session_id and ps.user_id = (select auth.uid()))
    );
