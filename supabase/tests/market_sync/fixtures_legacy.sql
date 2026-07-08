-- Runs AFTER 0001..0016 and BEFORE 0017: recreates the legacy world so 0017's
-- backfill and the old-clone bug (mnemonics/synonyms lost) are exercised.
\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data) values
    ('11111111-1111-1111-1111-111111111111', 'alice@test.dev', '{"full_name":"Alice"}'),
    ('22222222-2222-2222-2222-222222222222', 'bob@test.dev',   '{"full_name":"Bob"}'),
    ('33333333-3333-3333-3333-333333333333', 'carol@test.dev', '{"full_name":"Carol"}');

-- Market deck (user_id IS NULL) with three fully-enriched cards.
insert into public.decks (slug, title, description, user_id)
values ('animals', 'Animals', 'Animal vocabulary', null);

insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech,
    definition_en, main_translations_es, collocations, synonyms_en, example_es, example_en, mnemonic_en)
select d.id, v.* from public.decks d,
(values
    ('el perro', 'dog', 'Pets', 'noun', 'A domesticated canine',
     '["el can"]'::jsonb, '["perro guardián"]'::jsonb, '["hound"]'::jsonb,
     'El perro ladra.', 'The dog barks.', 'PERRO sounds like PURR-oh.'),
    ('el gato', 'cat', 'Pets', 'noun', 'A domesticated feline',
     '["el minino"]'::jsonb, '["gato callejero"]'::jsonb, '["feline"]'::jsonb,
     'El gato duerme.', 'The cat sleeps.', 'GATO - a cat at the GATE-oh.'),
    ('el pajaro', 'bird', 'Wild', 'noun', 'A feathered flying animal',
     '["el ave"]'::jsonb, '["pajaro carpintero"]'::jsonb, '["fowl"]'::jsonb,
     'El pajaro canta.', 'The bird sings.', 'PAJARO - a bird in PAJAMAS-oh.')
) as v(spanish_text, english_text, section_name, part_of_speech, definition_en,
       main_translations_es, collocations, synonyms_en, example_es, example_en, mnemonic_en)
where d.slug = 'animals';

-- Alice clones it through the real pre-0017 RPC path (old _duplicate drops
-- mnemonic_en/synonyms_en - that is the point).
select set_config('app.uid', '11111111-1111-1111-1111-111111111111', false);
select public.update_deck_home_selection((select id from public.decks where slug = 'animals'), true);

-- Legacy local edit: Alice tweaks her copy of 'el gato' before 0017 exists.
select public.update_card(
    (select c.id from public.cards c join public.decks d on d.id = c.deck_id
     where d.user_id = '11111111-1111-1111-1111-111111111111'::uuid and c.spanish_text = 'el gato'),
    'el gato', 'cat (kitty)', 'Pets', 'noun', 'A domesticated feline',
    array['el minino'], array['gato callejero'], array[]::text[],
    null, 'El gato duerme.', 'The cat sleeps.', null
);

select set_config('app.uid', '', false);
