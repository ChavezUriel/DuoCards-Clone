-- ===========================================================================
-- 0007: Harden smart-practice session resume so a "dead" session can never
--       trap the user.
--
-- start_smart_practice_session resumes any still-'active' session before it
-- considers creating a new one. A session can end up 'active' yet have no
-- *presentable* current card, for example when:
--   * every remaining pending card belongs to a deck that was later removed
--     from smart practice or deselected from home,
--   * a pending card was disabled or is no longer 'refined', or
--   * the last card was completed without the session being flipped to
--     'completed' (a bookkeeping hole in an earlier build).
-- _practice_session_snapshot then returns current_card = null, the UI shows
-- "Session complete", and because the dead session keeps being resumed the user
-- can never start a fresh one -- the app looks stuck.
--
-- Fix: when a resumable session is found, confirm it still has at least one card
-- that would actually be shown -- using the *same* filter the snapshot uses to
-- choose current_card. If it does not, retire the session (mark it completed)
-- and fall through to building a brand-new session. This auto-heals existing
-- stranded sessions on the next start and prevents the class of bug entirely.
-- ===========================================================================

create or replace function public.start_smart_practice_session(
    p_new_block_size int default 7,
    p_review_batch_size int default 30,
    p_interleaving_intensity text default 'medium',
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
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    -- validate settings (mirrors SmartPracticeSettings)
    if p_new_block_size < 5 or p_new_block_size > 12 then raise exception 'new_block_size out of range'; end if;
    if p_review_batch_size < 20 or p_review_batch_size > 50 then raise exception 'review_batch_size out of range'; end if;
    if p_interleaving_intensity not in ('low', 'medium', 'high') then raise exception 'invalid interleaving_intensity'; end if;
    if p_focus_mode not in ('auto', 'new_material', 'review') then raise exception 'invalid focus_mode'; end if;

    -- resume an existing active session if present
    select id into v_session_id
    from public.practice_sessions
    where status = 'active' and user_id = v_uid
    order by updated_at desc, id desc limit 1;

    -- ...but only if that session can still present a card. Guard against a dead
    -- session (no pending card that passes the snapshot's current_card filter):
    -- retire it and build a fresh one instead of handing back an unusable round.
    if v_session_id is not null and not exists (
        select 1
        from public.practice_session_cards psc
        join public.cards c on c.id = psc.card_id
        join public.decks d on d.id = c.deck_id
        where psc.session_id = v_session_id
          and psc.status = 'pending'
          and c.is_enabled and c.generation_phase = 'refined'
          and d.is_selected_on_home and d.is_enabled_in_smart_practice
    ) then
        update public.practice_sessions
        set status = 'completed', completed_at = v_now, updated_at = v_now
        where id = v_session_id;
        v_session_id := null;
    end if;

    if v_session_id is null then
        v_mode := public._choose_session_mode(v_uid, p_focus_mode);
        v_new_limit := case when v_mode = 'review' then 0 else p_new_block_size end;
        v_review_limit := case when v_mode = 'new_material' then 0 else p_review_batch_size end;

        insert into public.practice_sessions (
            status, scope, mode, focus_mode, new_block_size, review_batch_size,
            interleaving_intensity, user_id, created_at, updated_at
        )
        values (
            'active', 'global', v_mode, p_focus_mode, p_new_block_size, p_review_batch_size,
            p_interleaving_intensity, v_uid, v_now, v_now
        )
        returning id into v_session_id;

        -- Pick new cards at random; pick reviews due-first ordered by predicted
        -- recall (lowest retrievability = most at risk of being forgotten),
        -- topping up with the soonest-due cards when not enough are due yet.
        -- Interleaving: low = new block first, then reviews (blocked);
        -- medium = new cards spread evenly through the review queue;
        -- high = everything shuffled together.
        insert into public.practice_session_cards (session_id, card_id, queue_position, card_kind)
        select v_session_id, merged.card_id,
               (row_number() over (order by merged.sort_key, merged.card_id))::int - 1,
               merged.card_kind
        from (
            select np.card_id, 'new'::text as card_kind,
                   case p_interleaving_intensity
                       when 'low' then np.rn::double precision
                       when 'high' then random() * 1000
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
                   case p_interleaving_intensity
                       when 'low' then 1000000 + rp.rn::double precision
                       when 'high' then random() * 1000
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
    end if;

    return public._practice_session_snapshot(v_session_id, v_uid);
end;
$$;
