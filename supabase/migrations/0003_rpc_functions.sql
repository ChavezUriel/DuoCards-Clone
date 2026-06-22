-- RPC functions: faithful port of the original FastAPI endpoints
-- and the smart-practice algorithm (the FastAPI/SQLite backend, since removed).
--
-- Convention: public-facing RPCs are SECURITY DEFINER and enforce ownership
-- explicitly via auth.uid() (mirroring the old `WHERE user_id = ?` checks).
-- Helper functions (prefixed `_`) are not exposed to clients.

-- ===========================================================================
-- Helpers
-- ===========================================================================

-- Normalize a list of strings: trim, drop blanks, dedupe case-insensitively,
-- preserve first-seen order. Returns a jsonb array.
create or replace function public._norm_text_items(p_items text[])
returns jsonb
language plpgsql
immutable
as $$
declare
    v_item text;
    v_norm text;
    v_key  text;
    v_seen text[] := '{}';
    v_out  jsonb := '[]'::jsonb;
begin
    if p_items is null then
        return '[]'::jsonb;
    end if;
    foreach v_item in array p_items loop
        v_norm := nullif(trim(v_item), '');
        if v_norm is null then continue; end if;
        v_key := lower(v_norm);
        if v_key = any(v_seen) then continue; end if;
        v_seen := array_append(v_seen, v_key);
        v_out := v_out || to_jsonb(v_norm);
    end loop;
    return v_out;
end;
$$;

-- Build the ReviewCard JSON shape for a single card.
create or replace function public._review_card_json(p_card_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object(
        'card_id', c.id,
        'deck_id', c.deck_id,
        'deck_title', d.title,
        'section_name', coalesce(c.section_name, d.title),
        'prompt_es', c.spanish_text,
        'answer_en', c.english_text,
        'part_of_speech', c.part_of_speech,
        'definition_en', c.definition_en,
        'main_translations_es', coalesce(c.main_translations_es, '[]'::jsonb),
        'collocations', coalesce(c.collocations, '[]'::jsonb),
        'example_sentence', c.example_sentence,
        'example_es', c.example_es,
        'example_en', c.example_en
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

-- Build the DeckPreviewCard JSON shape for a single card.
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
        'example_sentence', c.example_sentence,
        'example_es', c.example_es,
        'example_en', c.example_en
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

-- Apply a review result to card_progress (shared by both review flows).
create or replace function public._apply_card_progress(p_card_id bigint, p_user_id uuid, p_result text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_known   integer := 0;
    v_unknown integer := 0;
    v_streak  integer := 0;
    v_mastered timestamptz := null;
    v_now timestamptz := now();
begin
    select known_count, unknown_count, known_streak, initial_mastered_at
    into v_known, v_unknown, v_streak, v_mastered
    from public.card_progress
    where card_id = p_card_id;

    v_known   := coalesce(v_known, 0);
    v_unknown := coalesce(v_unknown, 0);
    v_streak  := coalesce(v_streak, 0);

    if p_result = 'known' then
        v_known := v_known + 1;
        v_streak := v_streak + 1;
        if v_streak >= 2 and v_mastered is null then
            v_mastered := v_now;
        end if;
    else
        v_unknown := v_unknown + 1;
        v_streak := 0;
    end if;

    insert into public.card_progress (
        card_id, user_id, known_count, unknown_count, known_streak,
        last_result, last_reviewed_at, initial_mastered_at
    )
    values (p_card_id, p_user_id, v_known, v_unknown, v_streak, p_result, v_now, v_mastered)
    on conflict (card_id) do update set
        known_count = excluded.known_count,
        unknown_count = excluded.unknown_count,
        known_streak = excluded.known_streak,
        last_result = excluded.last_result,
        last_reviewed_at = excluded.last_reviewed_at,
        initial_mastered_at = excluded.initial_mastered_at;

    return jsonb_build_object(
        'known_count', v_known,
        'unknown_count', v_unknown,
        'known_streak', v_streak,
        'initial_mastered_at', v_mastered,
        'last_reviewed_at', v_now
    );
end;
$$;

-- Clear pending practice cards belonging to a deck and tidy up sessions.
create or replace function public._clear_pending_practice_cards_for_deck(p_deck_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := now();
    v_sessions bigint[];
begin
    v_sessions := array(
        select distinct psc.session_id
        from public.practice_session_cards psc
        join public.cards c on c.id = psc.card_id
        where c.deck_id = p_deck_id and psc.status = 'pending'
    );

    delete from public.practice_session_cards psc
    using public.cards c
    where psc.card_id = c.id and c.deck_id = p_deck_id and psc.status = 'pending';

    if array_length(v_sessions, 1) is null then
        return;
    end if;

    update public.practice_sessions ps
    set status = 'completed', completed_at = v_now, updated_at = v_now
    where ps.id = any(v_sessions) and ps.status = 'active'
      and not exists (
          select 1 from public.practice_session_cards psc
          where psc.session_id = ps.id and psc.status = 'pending'
      );

    update public.practice_sessions ps
    set updated_at = v_now
    where ps.id = any(v_sessions) and ps.status = 'active'
      and exists (
          select 1 from public.practice_session_cards psc
          where psc.session_id = ps.id and psc.status = 'pending'
      );
end;
$$;

-- Clone a global base deck (and its cards) into a per-user deck.
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
        main_translations_es, collocations, example_sentence, example_es, example_en
    )
    select
        v_new_deck_id, spanish_text, english_text, is_enabled, generation_phase,
        generation_metadata, section_name, part_of_speech, definition_en,
        main_translations_es, collocations, example_sentence, example_es, example_en
    from public.cards
    where deck_id = p_base_deck_id;

    return v_new_deck_id;
end;
$$;

-- ===========================================================================
-- Deck queries
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

create or replace function public.get_review_card(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_card_id bigint;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    if not exists (
        select 1 from public.decks
        where id = p_deck_id and is_selected_on_home and user_id = v_uid
    ) then
        raise exception 'Deck not found or not on home';
    end if;

    select c.id into v_card_id
    from public.cards c
    left join public.card_progress cp on cp.card_id = c.id
    where c.deck_id = p_deck_id and c.is_enabled and c.generation_phase = 'refined'
    order by
        (case when cp.last_result is null then 0 when cp.last_result = 'unknown' then 1 else 2 end) asc,
        (case when cp.last_result = 'unknown' then coalesce(cp.unknown_count, 0) * -1 else 0 end) asc,
        (case when cp.last_result = 'known' then coalesce(cp.known_count, 0) else 0 end) asc,
        coalesce(cp.last_reviewed_at, '1970-01-01T00:00:00+00:00'::timestamptz) asc,
        c.id asc
    limit 1;

    if v_card_id is null then
        raise exception 'Deck has no cards';
    end if;

    return public._review_card_json(v_card_id);
end;
$$;

create or replace function public.get_deck_progress(p_deck_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_total int; v_reviewed int; v_known int; v_unknown int;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    if not exists (
        select 1 from public.decks
        where id = p_deck_id and is_selected_on_home and user_id = v_uid
    ) then
        raise exception 'Deck not found or not on home';
    end if;

    select
        count(c.id)::int,
        coalesce(sum(case when cp.last_result is not null then 1 else 0 end), 0)::int,
        coalesce(sum(case when cp.last_result = 'known' then 1 else 0 end), 0)::int,
        coalesce(sum(case when cp.last_result = 'unknown' then 1 else 0 end), 0)::int
    into v_total, v_reviewed, v_known, v_unknown
    from public.cards c
    left join public.card_progress cp on cp.card_id = c.id
    where c.deck_id = p_deck_id and c.is_enabled and c.generation_phase = 'refined';

    return jsonb_build_object(
        'deck_id', p_deck_id,
        'total_cards', v_total,
        'reviewed_cards', v_reviewed,
        'known_cards', v_known,
        'unknown_cards', v_unknown,
        'completion_ratio', case when v_total > 0 then v_reviewed::float / v_total else 0 end,
        'is_completed', (v_total > 0 and v_known = v_total)
    );
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
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select * into v_deck
    from public.decks
    where id = p_deck_id and (user_id = v_uid or user_id is null);
    if not found then
        raise exception 'Deck not found or not on home';
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
        'cards', v_cards
    );
end;
$$;

-- ===========================================================================
-- Reviews & card mutations
-- ===========================================================================

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
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_result not in ('known', 'unknown') then raise exception 'Invalid result'; end if;

    select d.user_id into v_owner
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id and c.is_enabled and c.generation_phase = 'refined';

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to review this card'; end if;

    v_progress := public._apply_card_progress(p_card_id, v_uid, p_result);

    return jsonb_build_object(
        'card_id', p_card_id,
        'result', p_result,
        'reviewed_at', v_progress ->> 'last_reviewed_at',
        'known_count', (v_progress ->> 'known_count')::int,
        'unknown_count', (v_progress ->> 'unknown_count')::int
    );
end;
$$;

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
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select c.deck_id, d.user_id into v_deck_id, v_owner
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to modify this card'; end if;

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
    p_example_sentence text default null,
    p_example_es text default null,
    p_example_en text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_prompt text;
    v_answer text;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select d.user_id into v_owner
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;

    if not found then raise exception 'Card not found'; end if;
    if v_owner is distinct from v_uid then raise exception 'Not authorized to modify this card'; end if;

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
        example_sentence = nullif(trim(p_example_sentence), ''),
        example_es = nullif(trim(p_example_es), ''),
        example_en = nullif(trim(p_example_en), '')
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

-- ===========================================================================
-- Deck selection / smart-practice inclusion
-- ===========================================================================

create or replace function public.update_deck_home_selection(p_deck_id bigint, p_is_selected_on_home boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_target bigint := p_deck_id;
    v_user_deck bigint;
    v_found boolean;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select user_id into v_owner from public.decks where id = p_deck_id;
    if not found then raise exception 'Deck not found'; end if;

    if v_owner is null then
        select id into v_user_deck from public.decks where user_id = v_uid and base_deck_id = p_deck_id;
        if found then
            v_target := v_user_deck;
        else
            if not p_is_selected_on_home then
                return jsonb_build_object('deck_id', p_deck_id, 'is_selected_on_home', false);
            end if;
            v_target := public._duplicate_base_deck_to_user(p_deck_id, v_uid);
        end if;
    elsif v_owner is distinct from v_uid then
        raise exception 'Not authorized to modify this deck';
    end if;

    update public.decks set is_selected_on_home = p_is_selected_on_home where id = v_target;

    if not p_is_selected_on_home then
        perform public._clear_pending_practice_cards_for_deck(v_target);
    end if;

    return jsonb_build_object('deck_id', p_deck_id, 'is_selected_on_home', p_is_selected_on_home);
end;
$$;

create or replace function public.update_deck_smart_practice_inclusion(p_deck_id bigint, p_is_enabled_in_smart_practice boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_owner uuid;
    v_target bigint := p_deck_id;
    v_is_selected boolean;
    v_user_deck_id bigint;
    v_user_deck_selected boolean;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select user_id, is_selected_on_home into v_owner, v_is_selected
    from public.decks where id = p_deck_id;
    if not found then raise exception 'Deck not found'; end if;

    if v_owner is null then
        select id, is_selected_on_home into v_user_deck_id, v_user_deck_selected
        from public.decks where user_id = v_uid and base_deck_id = p_deck_id;
        if found then
            v_target := v_user_deck_id;
            v_is_selected := v_user_deck_selected;
        else
            v_target := public._duplicate_base_deck_to_user(p_deck_id, v_uid);
            v_is_selected := true;
        end if;
    elsif v_owner is distinct from v_uid then
        raise exception 'Not authorized to modify this deck';
    end if;

    if not v_is_selected then
        raise exception 'Deck not selected on home';
    end if;

    update public.decks set is_enabled_in_smart_practice = p_is_enabled_in_smart_practice where id = v_target;

    if not p_is_enabled_in_smart_practice then
        perform public._clear_pending_practice_cards_for_deck(v_target);
    end if;

    return jsonb_build_object('deck_id', p_deck_id, 'is_enabled_in_smart_practice', p_is_enabled_in_smart_practice);
end;
$$;

-- ===========================================================================
-- Smart practice sessions
-- ===========================================================================

create or replace function public._practice_session_snapshot(p_session_id bigint, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_summary record;
    v_card_id bigint;
    v_current jsonb := null;
begin
    select
        ps.id as session_id, ps.status, ps.mode, ps.focus_mode,
        ps.new_block_size, ps.review_batch_size, ps.interleaving_intensity,
        count(psc.card_id)::int as total_cards,
        coalesce(sum(case when psc.status = 'completed' then 1 else 0 end), 0)::int as completed_cards,
        coalesce(sum(case when psc.status = 'pending' then 1 else 0 end), 0)::int as remaining_cards
    into v_summary
    from public.practice_sessions ps
    left join public.practice_session_cards psc on psc.session_id = ps.id
    where ps.id = p_session_id and ps.user_id = p_user_id
    group by ps.id;

    if not found then
        return null;
    end if;

    select psc.card_id into v_card_id
    from public.practice_session_cards psc
    join public.cards c on c.id = psc.card_id
    join public.decks d on d.id = c.deck_id
    where psc.session_id = p_session_id
      and psc.status = 'pending'
      and c.is_enabled and c.generation_phase = 'refined'
      and d.is_selected_on_home and d.is_enabled_in_smart_practice
    order by psc.queue_position asc
    limit 1;

    if v_card_id is not null then
        v_current := public._review_card_json(v_card_id);
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
            'new_block_size', v_summary.new_block_size,
            'review_batch_size', v_summary.review_batch_size,
            'interleaving_intensity', v_summary.interleaving_intensity
        ),
        'current_card', v_current
    );
end;
$$;

create or replace function public._choose_session_mode(p_user_id uuid, p_review_batch_size int, p_focus_mode text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_unmastered int; v_learned int; v_last_mode text;
begin
    select
        coalesce(sum(case when cp.initial_mastered_at is null then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is not null then 1 else 0 end), 0)
    into v_unmastered, v_learned
    from public.cards c
    join public.decks d on d.id = c.deck_id
    left join public.card_progress cp on cp.card_id = c.id
    where c.is_enabled and c.generation_phase = 'refined'
      and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = p_user_id;

    if p_focus_mode = 'new_material' then
        if v_unmastered > 0 then return 'new_material'; end if;
        if v_learned > 0 then return 'review'; end if;
    elsif p_focus_mode = 'review' then
        if v_learned > 0 then return 'review'; end if;
        if v_unmastered > 0 then return 'new_material'; end if;
    else
        if v_unmastered > 0 and v_learned > 0 then
            select mode into v_last_mode
            from public.practice_sessions
            where status <> 'active' and user_id = p_user_id
            order by updated_at desc, id desc limit 1;

            if v_last_mode = 'new_material' and v_learned >= greatest(10, p_review_batch_size / 2) then
                return 'review';
            end if;
            if v_last_mode = 'review' then
                return 'new_material';
            end if;
            if v_learned >= greatest(10, p_review_batch_size / 2) then
                return 'review';
            end if;
            return 'new_material';
        end if;
        if v_unmastered > 0 then return 'new_material'; end if;
        if v_learned > 0 then return 'review'; end if;
    end if;

    raise exception 'No cards are available for smart practice';
end;
$$;

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

    if v_session_id is null then
        v_mode := public._choose_session_mode(v_uid, p_review_batch_size, p_focus_mode);

        insert into public.practice_sessions (
            status, scope, mode, focus_mode, new_block_size, review_batch_size,
            interleaving_intensity, user_id, created_at, updated_at
        )
        values (
            'active', 'global', v_mode, p_focus_mode, p_new_block_size, p_review_batch_size,
            p_interleaving_intensity, v_uid, v_now, v_now
        )
        returning id into v_session_id;

        if v_mode = 'new_material' then
            insert into public.practice_session_cards (session_id, card_id, queue_position)
            select v_session_id, picked.card_id, (row_number() over ()) - 1
            from (
                select c.id as card_id
                from public.cards c
                join public.decks d on d.id = c.deck_id
                left join public.card_progress cp on cp.card_id = c.id
                where c.is_enabled and c.generation_phase = 'refined'
                  and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = v_uid
                  and (cp.initial_mastered_at is null or cp.card_id is null)
                order by random()
                limit p_new_block_size
            ) picked;
        else
            insert into public.practice_session_cards (session_id, card_id, queue_position)
            select v_session_id, picked.card_id, (row_number() over ()) - 1
            from (
                select c.id as card_id
                from public.cards c
                join public.decks d on d.id = c.deck_id
                join public.card_progress cp on cp.card_id = c.id
                where c.is_enabled and c.generation_phase = 'refined'
                  and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = v_uid
                  and cp.initial_mastered_at is not null
                order by random()
                limit p_review_batch_size
            ) picked;
        end if;

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

create or replace function public.get_smart_practice_session(p_session_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_snapshot jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    v_snapshot := public._practice_session_snapshot(p_session_id, v_uid);
    if v_snapshot is null then raise exception 'Smart practice session not found'; end if;
    return v_snapshot;
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
    v_mode text; v_status text;
    v_entry_id bigint; v_entry_card_id bigint;
    v_progress jsonb;
    v_should_repeat boolean;
    v_now timestamptz := now();
    v_next_pos int;
    v_pending int;
    v_snapshot jsonb;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
    if p_result not in ('known', 'unknown') then raise exception 'Invalid result'; end if;

    select mode, status into v_mode, v_status
    from public.practice_sessions where id = p_session_id and user_id = v_uid;
    if not found then raise exception 'Smart practice session not found'; end if;
    if v_status <> 'active' then raise exception 'Smart practice session is no longer active'; end if;

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

    v_progress := public._apply_card_progress(p_card_id, v_uid, p_result);

    if v_mode = 'new_material' then
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

    v_snapshot := public._practice_session_snapshot(p_session_id, v_uid);
    return jsonb_build_object('session', v_snapshot);
end;
$$;

-- ===========================================================================
-- Lock down helper functions; expose only the public RPCs to clients.
-- ===========================================================================
revoke execute on function public._norm_text_items(text[]) from public;
revoke execute on function public._review_card_json(bigint) from public;
revoke execute on function public._preview_card_json(bigint) from public;
revoke execute on function public._apply_card_progress(bigint, uuid, text) from public;
revoke execute on function public._clear_pending_practice_cards_for_deck(bigint) from public;
revoke execute on function public._duplicate_base_deck_to_user(bigint, uuid) from public;
revoke execute on function public._practice_session_snapshot(bigint, uuid) from public;
revoke execute on function public._choose_session_mode(uuid, int, text) from public;

notify pgrst, 'reload schema';
