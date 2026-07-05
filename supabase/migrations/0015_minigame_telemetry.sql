-- ===========================================================================
-- 0015: Minigames Phase 6 — engagement telemetry (minigame_plays).
--
-- See docs/minigames.md §10, §9 (Phase 6). A purely additive analytics sink for
-- how minigames are played. It is NEVER read by the scheduler and touches nothing
-- in the FSRS path (submit_smart_practice_review / _apply_card_progress / the
-- 2-streak are all untouched) — with this migration absent or the table empty the
-- app behaves exactly as it did after Phase 5.
--
--   * minigame_plays — one row per logged play: which game, the outcome
--     ('known' / 'unknown' / 'skip' / a depth-game result), and whether that play
--     counted toward FSRS. card_id is nullable + ON DELETE SET NULL so deleting a
--     card never erases play history.
--   * log_minigame_play(card_id, game, outcome, counted) — SECURITY DEFINER write
--     path (mirrors the 0013/0014 grant style). Best-effort: it normalizes/clamps
--     the free-text fields and silently no-ops on blank input, so a telemetry
--     failure can never surface in the practice UI.
--
-- Reads are gated to your own rows by RLS; there is deliberately NO insert/update/
-- delete policy, so the only write path is the SECURITY DEFINER RPC.
-- ===========================================================================

create table if not exists public.minigame_plays (
    id         bigint generated always as identity primary key,
    user_id    uuid not null references auth.users (id) on delete cascade,
    -- Nullable + SET NULL: telemetry is historical, so a later card deletion
    -- should blank the pointer, not cascade-delete the play record.
    card_id    bigint references public.cards (id) on delete set null,
    game       text not null,
    outcome    text not null,
    counted    boolean not null default false,
    created_at timestamptz not null default now()
);

create index if not exists minigame_plays_user_created_idx
    on public.minigame_plays (user_id, created_at desc);

alter table public.minigame_plays enable row level security;

-- Read-your-own analytics only. Writes flow exclusively through log_minigame_play
-- (SECURITY DEFINER, which bypasses RLS), so no insert/update/delete policy exists.
create policy "minigame_plays_select_own" on public.minigame_plays
    for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Write path. Additive, best-effort: never raises for bad content (only for a
-- missing auth context), so the frontend can fire-and-forget without a failed log
-- ever disrupting a review.
-- ---------------------------------------------------------------------------
create or replace function public.log_minigame_play(
    p_card_id bigint,
    p_game text,
    p_outcome text,
    p_counted boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_game text;
    v_outcome text;
    v_card_id bigint;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- Normalize + clamp the free-text fields so a malformed caller can never bloat
    -- the table; silently no-op on blank input rather than raise (a telemetry error
    -- must never bubble into the practice UI).
    v_game := nullif(left(btrim(coalesce(p_game, '')), 64), '');
    v_outcome := nullif(left(btrim(coalesce(p_outcome, '')), 64), '');
    if v_game is null or v_outcome is null then
        return;
    end if;

    -- Only attach the card pointer when the caller actually owns it (or it is a
    -- global/starter card); otherwise log the play with a null card. This keeps the
    -- reference honest and dodges an FK failure on a stale/foreign id.
    select c.id into v_card_id
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id and (d.user_id = v_uid or d.user_id is null);

    insert into public.minigame_plays (user_id, card_id, game, outcome, counted)
    values (v_uid, v_card_id, v_game, v_outcome, coalesce(p_counted, false));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: authenticated-only, matching the 0013/0014 RPC ACLs.
-- ---------------------------------------------------------------------------
revoke execute on function public.log_minigame_play(bigint, text, text, boolean) from public, anon;
grant execute on function public.log_minigame_play(bigint, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';
