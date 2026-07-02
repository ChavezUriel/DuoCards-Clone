-- FSRS-based spaced repetition + interleaved smart practice.
--
-- What changes:
--   1. cards gains mnemonic_en (keyword-method memory hook, evidence-based for
--      vocabulary; populated by the enrichment pipeline).
--   2. card_progress gains FSRS memory-state columns (stability/difficulty/
--      due_at/state/reps/lapses). Every review feeds the FSRS-5 scheduler with
--      default parameters; binary grades map to Again(1)/Good(3).
--   3. Review sessions pick DUE cards first (lowest predicted recall first)
--      instead of random mastered cards.
--   4. New 'mixed' session mode interleaves a new-material block with due
--      reviews; interleaving_intensity now controls the actual mixing pattern
--      (low = blocked, medium = evenly spread, high = fully shuffled).
--   5. get_due_summary() powers the home-page due counts and reminders.

-- ===========================================================================
-- Schema changes
-- ===========================================================================

alter table public.cards add column if not exists mnemonic_en text;

alter table public.card_progress
    add column if not exists stability  double precision,
    add column if not exists difficulty double precision,
    add column if not exists due_at     timestamptz,
    add column if not exists state      text not null default 'new'
        check (state in ('new', 'learning', 'review', 'relearning')),
    add column if not exists reps       integer not null default 0,
    add column if not exists lapses     integer not null default 0;

create index if not exists card_progress_user_due_idx
    on public.card_progress (user_id, due_at);

-- Backfill rows that predate FSRS: derive state from the mastery marker and
-- make previously "learned" cards due immediately (their first real scheduled
-- review). stability/difficulty stay null — FSRS initializes them on the next
-- review, since there is no reliable history to fit from.
update public.card_progress set
    state  = case when initial_mastered_at is not null then 'review' else 'learning' end,
    reps   = known_count + unknown_count,
    lapses = unknown_count,
    due_at = coalesce(last_reviewed_at, now())
where state = 'new' and (known_count > 0 or unknown_count > 0);

-- Allow the interleaved session mode.
alter table public.practice_sessions drop constraint if exists practice_sessions_mode_check;
alter table public.practice_sessions
    add constraint practice_sessions_mode_check check (mode in ('new_material', 'review', 'mixed'));

-- Each queued card keeps its own repeat rule (new cards repeat until the
-- in-session mastery streak; review cards repeat only on a miss).
alter table public.practice_session_cards
    add column if not exists card_kind text not null default 'review'
        check (card_kind in ('new', 'review'));

update public.practice_session_cards psc
set card_kind = 'new'
from public.practice_sessions ps
where ps.id = psc.session_id and ps.mode = 'new_material' and psc.card_kind <> 'new';

-- ===========================================================================
-- FSRS-5 core (default parameters, desired retention 0.9)
-- ===========================================================================

-- Apply one review to a card's FSRS memory state.
-- p_rating: 1 = Again (unknown), 3 = Good (known). Null stability/difficulty
-- means "first review" and triggers the initial-state formulas.
create or replace function public._fsrs_apply(
    p_stability double precision,
    p_difficulty double precision,
    p_elapsed_days double precision,
    p_rating integer
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
    -- FSRS-5 default parameters w0..w18 (1-indexed: w[k] = w_{k-1}).
    w constant double precision[] := array[
        0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
        1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
        2.9898, 0.51655, 0.6621
    ];
    v_decay  constant double precision := -0.5;
    v_factor constant double precision := 19.0 / 81.0;
    v_s double precision;
    v_d double precision;
    v_r double precision;
begin
    if p_stability is null or p_difficulty is null then
        -- Initial state: S0(G) = w_{G-1}; D0(G) = w4 - e^{w5(G-1)} + 1.
        v_s := case when p_rating >= 3 then w[3] else w[1] end;
        v_d := w[5] - exp(w[6] * (p_rating - 1)) + 1;
    else
        -- Difficulty: linear-damped delta plus mean reversion toward D0(4).
        v_d := p_difficulty + (-w[7] * (p_rating - 3)) * ((10 - p_difficulty) / 9.0);
        v_d := w[8] * (w[5] - exp(w[6] * 3) + 1) + (1 - w[8]) * v_d;

        if p_elapsed_days < 1 then
            -- Same-day review: S' = S * e^{w17 (G - 3 + w18)}.
            v_s := p_stability * exp(w[18] * (p_rating - 3 + w[19]));
            if p_rating < 3 then
                v_s := least(v_s, p_stability);
            end if;
        else
            -- Retrievability at review time: R = (1 + FACTOR * t/S)^DECAY.
            v_r := power(1 + v_factor * p_elapsed_days / p_stability, v_decay);
            if p_rating < 3 then
                -- Post-lapse stability, capped at the pre-lapse value.
                v_s := w[12] * power(p_difficulty, -w[13])
                       * (power(p_stability + 1, w[14]) - 1)
                       * exp(w[15] * (1 - v_r));
                v_s := least(v_s, p_stability);
            else
                -- Successful review (binary grades: no hard/easy multipliers).
                v_s := p_stability * (
                    exp(w[9]) * (11 - p_difficulty)
                    * power(p_stability, -w[10])
                    * (exp(w[11] * (1 - v_r)) - 1)
                    + 1
                );
            end if;
        end if;
    end if;

    v_d := least(greatest(v_d, 1), 10);
    v_s := least(greatest(v_s, 0.01), 36500);
    return jsonb_build_object('stability', v_s, 'difficulty', v_d);
end;
$$;

-- Interval for desired retention 0.9. With FACTOR = 19/81 the interval equals
-- the stability, so this just rounds, clamps, and applies a +/-5% fuzz (fuzz
-- prevents cards learned together from staying clumped forever).
create or replace function public._fsrs_interval_days(p_stability double precision)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
    v_days double precision := p_stability;
begin
    if v_days >= 3 then
        v_days := v_days * (0.95 + random() * 0.1);
    end if;
    return greatest(1, least(365, round(v_days)::int));
end;
$$;

-- ===========================================================================
-- Progress application (now FSRS-aware)
-- ===========================================================================

create or replace function public._apply_card_progress(p_card_id bigint, p_user_id uuid, p_result text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_known    integer := 0;
    v_unknown  integer := 0;
    v_streak   integer := 0;
    v_mastered timestamptz := null;
    v_stability  double precision := null;
    v_difficulty double precision := null;
    v_state      text := 'new';
    v_reps       integer := 0;
    v_lapses     integer := 0;
    v_last_reviewed timestamptz := null;
    v_now timestamptz := now();
    v_rating integer;
    v_elapsed double precision;
    v_fsrs jsonb;
    v_interval integer;
    v_due timestamptz;
begin
    select known_count, unknown_count, known_streak, initial_mastered_at,
           stability, difficulty, state, reps, lapses, last_reviewed_at
    into v_known, v_unknown, v_streak, v_mastered,
         v_stability, v_difficulty, v_state, v_reps, v_lapses, v_last_reviewed
    from public.card_progress
    where card_id = p_card_id;

    v_known   := coalesce(v_known, 0);
    v_unknown := coalesce(v_unknown, 0);
    v_streak  := coalesce(v_streak, 0);
    v_state   := coalesce(v_state, 'new');
    v_reps    := coalesce(v_reps, 0);
    v_lapses  := coalesce(v_lapses, 0);

    if p_result = 'known' then
        v_known := v_known + 1;
        v_streak := v_streak + 1;
        if v_streak >= 2 and v_mastered is null then
            v_mastered := v_now;
        end if;
    else
        v_unknown := v_unknown + 1;
        v_streak := 0;
        if v_state = 'review' then
            v_lapses := v_lapses + 1;
        end if;
    end if;

    -- FSRS memory-state update.
    v_rating := case when p_result = 'known' then 3 else 1 end;
    v_elapsed := case
        when v_last_reviewed is null then 0
        else greatest(0, extract(epoch from (v_now - v_last_reviewed)) / 86400.0)
    end;
    v_fsrs := public._fsrs_apply(v_stability, v_difficulty, v_elapsed, v_rating);
    v_stability  := (v_fsrs ->> 'stability')::double precision;
    v_difficulty := (v_fsrs ->> 'difficulty')::double precision;

    v_reps := v_reps + 1;
    v_interval := public._fsrs_interval_days(v_stability);
    v_due := v_now + make_interval(days => v_interval);

    if p_result = 'unknown' then
        v_state := case when v_state in ('review', 'relearning') then 'relearning' else 'learning' end;
    else
        v_state := case
            when v_state = 'relearning' then 'review'
            when v_mastered is not null then 'review'
            else 'learning'
        end;
    end if;

    insert into public.card_progress (
        card_id, user_id, known_count, unknown_count, known_streak,
        last_result, last_reviewed_at, initial_mastered_at,
        stability, difficulty, due_at, state, reps, lapses
    )
    values (
        p_card_id, p_user_id, v_known, v_unknown, v_streak,
        p_result, v_now, v_mastered,
        v_stability, v_difficulty, v_due, v_state, v_reps, v_lapses
    )
    on conflict (card_id) do update set
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

    return jsonb_build_object(
        'known_count', v_known,
        'unknown_count', v_unknown,
        'known_streak', v_streak,
        'initial_mastered_at', v_mastered,
        'last_reviewed_at', v_now,
        'stability', v_stability,
        'difficulty', v_difficulty,
        'due_at', v_due,
        'state', v_state,
        'interval_days', v_interval
    );
end;
$$;

-- ===========================================================================
-- Card JSON shapes: expose the mnemonic
-- ===========================================================================

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
        'example_en', c.example_en,
        'mnemonic_en', c.mnemonic_en
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

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
        'example_en', c.example_en,
        'mnemonic_en', c.mnemonic_en
    )
    from public.cards c
    join public.decks d on d.id = c.deck_id
    where c.id = p_card_id;
$$;

-- update_card gains the mnemonic field. Drop the old signature first so the
-- new default parameter does not create an ambiguous overload.
drop function if exists public.update_card(
    bigint, text, text, text, text, text, text[], text[], text, text, text
);

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
        example_en = nullif(trim(p_example_en), ''),
        mnemonic_en = nullif(trim(p_mnemonic_en), '')
    where id = p_card_id;

    return public._preview_card_json(p_card_id);
end;
$$;

-- ===========================================================================
-- Due summary (home page + reminders)
-- ===========================================================================

create or replace function public.get_due_summary()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_now timestamptz := now();
    v_due_now int; v_due_next_24h int; v_new int; v_learned int;
    v_next_due timestamptz;
begin
    if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;

    select
        coalesce(sum(case when cp.initial_mastered_at is not null
                           and coalesce(cp.due_at, v_now) <= v_now then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is not null
                           and cp.due_at > v_now
                           and cp.due_at <= v_now + interval '24 hours' then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is null or cp.card_id is null then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is not null then 1 else 0 end), 0),
        min(cp.due_at) filter (where cp.initial_mastered_at is not null and cp.due_at > v_now)
    into v_due_now, v_due_next_24h, v_new, v_learned, v_next_due
    from public.cards c
    join public.decks d on d.id = c.deck_id
    left join public.card_progress cp on cp.card_id = c.id
    where c.is_enabled and c.generation_phase = 'refined'
      and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = v_uid;

    return jsonb_build_object(
        'due_now', v_due_now,
        'due_next_24h', v_due_next_24h,
        'new_available', v_new,
        'learned_total', v_learned,
        'next_due_at', v_next_due
    );
end;
$$;

-- ===========================================================================
-- Session mode selection: due counts drive the choice; auto mixes both.
-- ===========================================================================

drop function if exists public._choose_session_mode(uuid, int, text);

create or replace function public._choose_session_mode(p_user_id uuid, p_focus_mode text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := now();
    v_new int; v_learned int; v_due int;
begin
    select
        coalesce(sum(case when cp.initial_mastered_at is null or cp.card_id is null then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is not null then 1 else 0 end), 0),
        coalesce(sum(case when cp.initial_mastered_at is not null
                           and coalesce(cp.due_at, v_now) <= v_now then 1 else 0 end), 0)
    into v_new, v_learned, v_due
    from public.cards c
    join public.decks d on d.id = c.deck_id
    left join public.card_progress cp on cp.card_id = c.id
    where c.is_enabled and c.generation_phase = 'refined'
      and d.is_selected_on_home and d.is_enabled_in_smart_practice and d.user_id = p_user_id;

    if p_focus_mode = 'new_material' then
        if v_new > 0 then return 'new_material'; end if;
        if v_learned > 0 then return 'review'; end if;
    elsif p_focus_mode = 'review' then
        if v_learned > 0 then return 'review'; end if;
        if v_new > 0 then return 'new_material'; end if;
    else
        -- auto: interleave when there is both fresh material and due reviews.
        if v_new > 0 and v_due > 0 then return 'mixed'; end if;
        if v_due > 0 then return 'review'; end if;
        if v_new > 0 then return 'new_material'; end if;
        if v_learned > 0 then return 'review'; end if;
    end if;

    raise exception 'No cards are available for smart practice';
end;
$$;

-- ===========================================================================
-- Session snapshot: expose per-kind remaining counts and the card kind.
-- ===========================================================================

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
            'interleaving_intensity', v_summary.interleaving_intensity
        ),
        'current_card', v_current
    );
end;
$$;

-- ===========================================================================
-- Session builder: due-first review picking + real interleaving.
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

-- ===========================================================================
-- Review submission: per-card repeat rules + scheduling feedback.
-- ===========================================================================

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

    select id, card_id, card_kind into v_entry_id, v_entry_card_id, v_entry_kind
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

-- ===========================================================================
-- Grants: lock helpers away from clients; expose the new public RPC.
-- ===========================================================================

revoke execute on function public._fsrs_apply(double precision, double precision, double precision, integer) from anon, authenticated, public;
revoke execute on function public._fsrs_interval_days(double precision) from anon, authenticated, public;
revoke execute on function public._choose_session_mode(uuid, text) from anon, authenticated, public;

revoke execute on function public.get_due_summary() from public, anon;
grant execute on function public.get_due_summary() to authenticated;

-- update_card was dropped and re-created, which resets its ACL to the default
-- PUBLIC grant — re-apply the authenticated-only policy.
revoke execute on function public.update_card(bigint, text, text, text, text, text, text[], text[], text, text, text, text) from public, anon;
grant execute on function public.update_card(bigint, text, text, text, text, text, text[], text[], text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
