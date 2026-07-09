-- Assertions for 0018 (get_minigame_distractors p_side='cloze') and 0019
-- (_review_card_json examples read-through). Each block raises on failure;
-- reaching the final notice means every scenario passed.

create or replace function pg_temp.card_id(p_deck_slug text, p_spanish text)
returns bigint
language sql
as $$
    select c.id from public.cards c
    join public.decks d on d.id = c.deck_id
    where d.slug = p_deck_slug and c.spanish_text = p_spanish
$$;

-- 1. Auth guard: no uid -> exception.
do $$
declare r jsonb;
begin
    perform set_config('app.uid', '', false);
    begin
        r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Pasaporte'), 3, 'cloze');
        raise exception 'FAIL 1: expected auth exception, got %', r;
    exception when sqlstate '28000' then null;
    end;
end $$;

-- 2. Ownership guard: another user's card -> exception.
do $$
declare r jsonb;
begin
    perform set_config('app.uid', '00000000-0000-0000-0000-000000000002', false);
    begin
        r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Pasaporte'), 3, 'cloze');
        raise exception 'FAIL 2: expected ownership exception, got %', r;
    exception when others then
        if sqlerrm not like '%Not authorized%' then raise; end if;
    end;
end $$;

-- Everything below acts as the owning user.
do $$ begin perform set_config('app.uid', '00000000-0000-0000-0000-000000000001', false); end $$;

-- 3. 'en' regression: sibling English answers, never the card's own answer or synonym.
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Pasaporte'), 3, 'en');
    if jsonb_array_length(r) <> 3 then raise exception 'FAIL 3: expected 3 siblings, got %', r; end if;
    if r ? 'Passport' or r ? 'travel document' then raise exception 'FAIL 3: answer/synonym leaked: %', r; end if;
end $$;

-- 4. 'es' regression: sibling Spanish prompts.
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Pasaporte'), 3, 'es');
    if jsonb_array_length(r) <> 3 then raise exception 'FAIL 4: expected 3 spanish siblings, got %', r; end if;
    if r ? 'Pasaporte' or r ? 'documento de viaje' then raise exception 'FAIL 4: prompt/translation leaked: %', r; end if;
end $$;

-- 5. 'cloze' on a clean copy: base card's curated set served via base_card_id.
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Pasaporte'), 3, 'cloze');
    if jsonb_array_length(r) <> 3 then raise exception 'FAIL 5: expected 3 curated options, got %', r; end if;
    if not ('["visa", "ID card", "boarding pass", "work permit"]'::jsonb @> r) then
        raise exception 'FAIL 5: options are not a subset of the base curated set: %', r;
    end if;
end $$;

-- 6. 'cloze' on a copy whose ANSWER was edited: read-through refused, sibling fallback.
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Pase de viaje'), 3, 'cloze');
    if jsonb_array_length(r) < 2 then raise exception 'FAIL 6: expected sibling fallback, got %', r; end if;
    if r ? 'visa' or r ? 'ID card' or r ? 'boarding pass' or r ? 'work permit' then
        raise exception 'FAIL 6: stale base options served to an edited copy: %', r;
    end if;
end $$;

-- 7. 'cloze' with OWN curated options: own set wins.
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Reembolso'), 3, 'cloze');
    if jsonb_array_length(r) <> 3 then raise exception 'FAIL 7: expected 3 own options, got %', r; end if;
    if not ('["deposit", "discount", "receipt"]'::jsonb @> r) then
        raise exception 'FAIL 7: options are not the card''s own curated set: %', r;
    end if;
end $$;

-- 8. 'cloze' when every own option filters out (answer/synonym/blank/dup): fallback.
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Propina'), 3, 'cloze');
    if jsonb_array_length(r) < 2 then raise exception 'FAIL 8: expected sibling fallback, got %', r; end if;
    if exists (select 1 from jsonb_array_elements_text(r) t where lower(trim(t)) in ('tip', 'gratuity')) then
        raise exception 'FAIL 8: filtered option leaked: %', r;
    end if;
end $$;

-- 9. 'cloze' with exactly 2 usable own options: served (>= 2 rule).
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Horario'), 3, 'cloze');
    if jsonb_array_length(r) <> 2 or not (r ? 'menu' and r ? 'map') then
        raise exception 'FAIL 9: expected the 2 own options, got %', r;
    end if;
end $$;

-- 10. 'cloze' when neither the copy nor its base has options: sibling fallback.
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Maleta'), 3, 'cloze');
    if jsonb_array_length(r) < 2 then raise exception 'FAIL 10: expected sibling fallback, got %', r; end if;
end $$;

-- 11. p_n clamp: asking for 8 returns at most what exists (3 own options).
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Reembolso'), 8, 'cloze');
    if jsonb_array_length(r) <> 3 then raise exception 'FAIL 11: expected all 3 own options, got %', r; end if;
end $$;

-- 12. Unknown side values still behave like 'en' (forward compat contract).
do $$
declare r jsonb;
begin
    r := public.get_minigame_distractors(pg_temp.card_id('u-travel', 'Pasaporte'), 3, 'nonsense');
    if jsonb_array_length(r) <> 3 or r ? 'visa' then
        raise exception 'FAIL 12: unknown side must fall back to sibling en, got %', r;
    end if;
end $$;

-- 13. 0019: _review_card_json serves the BASE card's example pairs to a clean copy.
do $$
declare j jsonb;
begin
    j := public._review_card_json(pg_temp.card_id('u-travel', 'Pasaporte'));
    if jsonb_array_length(j->'examples') <> 3 then
        raise exception 'FAIL 13: expected 3 read-through pairs, got %', j->'examples';
    end if;
    if (j->'examples'->0->>'en') <> 'I need to renew my passport before traveling to London.' then
        raise exception 'FAIL 13: unexpected first pair: %', j->'examples'->0;
    end if;
end $$;

-- 14. 0019: an edited copy (different answer) gets NO base pairs.
do $$
declare j jsonb;
begin
    j := public._review_card_json(pg_temp.card_id('u-travel', 'Pase de viaje'));
    if jsonb_array_length(j->'examples') <> 0 then
        raise exception 'FAIL 14: edited copy must not read through, got %', j->'examples';
    end if;
end $$;

-- 15. 0019: own pairs win over the base's.
do $$
declare j jsonb;
begin
    j := public._review_card_json(pg_temp.card_id('u-travel', 'Reembolso'));
    if jsonb_array_length(j->'examples') <> 3
       or (j->'examples'->1->>'en') not like '%refund%' then
        raise exception 'FAIL 15: expected the card''s own pairs, got %', j->'examples';
    end if;
end $$;

-- 16. 0019: global cards serve their own pairs directly.
do $$
declare j jsonb;
begin
    j := public._review_card_json(pg_temp.card_id('g-travel', 'Pasaporte'));
    if jsonb_array_length(j->'examples') <> 3 then
        raise exception 'FAIL 16: expected the global card''s pairs, got %', j->'examples';
    end if;
end $$;

do $$ begin raise notice 'ALL MINIGAME DISTRACTOR + EXAMPLES TESTS PASSED'; end $$;
