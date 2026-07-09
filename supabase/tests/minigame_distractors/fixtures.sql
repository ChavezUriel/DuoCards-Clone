-- Fixtures for the 0018/0019 harness: one global (market) deck, one user copy
-- deck covering every curated / base-read-through / fallback combination the
-- RPC and card JSON builders must handle.
--
-- Layout (all cards enabled + refined so they qualify for the sibling pool):
--   global deck g-travel (user_id null)
--     G1 Pasaporte -> Passport   3 example pairs + 4 curated distractors
--     G2 Maleta    -> Suitcase   no pairs, no distractors (pre-0018 shape)
--     G3..G5 filler siblings
--   user deck u-travel (owner u1, base g-travel)
--     C1 clean copy of G1 (base_card_id, same answer)     -> base read-through
--     C2 copy of G1 with EDITED english_text              -> read-through blocked
--     C3 own curated distractors + own example pairs      -> own served
--     C4 own distractors that all filter out (answer/syn) -> sibling fallback
--     C5 own distractors: exactly 2 usable                -> served (>= 2 rule)
--     C6 copy of G2 (base has nothing)                    -> sibling fallback
--     C7..C9 filler siblings for the fallback pool

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'u1@test.local'),
  ('00000000-0000-0000-0000-000000000002', 'u2@test.local');

do $$
declare
  v_g bigint;
  v_u bigint;
  v_g1 bigint;
  v_g2 bigint;
  v_examples jsonb := '[
    {"es": "Necesito renovar mi pasaporte antes de viajar a Londres.", "en": "I need to renew my passport before traveling to London."},
    {"es": "El agente selló mi pasaporte en el control.", "en": "The border agent stamped my passport at the checkpoint."},
    {"es": "Revisaron cada pasaporte antes de subir al ferry.", "en": "Officials checked every passport before we got on the ferry."}
  ]'::jsonb;
  v_curated jsonb := '["visa", "ID card", "boarding pass", "work permit"]'::jsonb;
begin
  insert into public.decks (slug, title, description, user_id)
  values ('g-travel', 'Travel', 'Travel deck', null)
  returning id into v_g;

  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech,
                            synonyms_en, main_translations_es, example_sentence, example_es, example_en,
                            cloze_distractors_en, examples)
  values (v_g, 'Pasaporte', 'Passport', 'Docs', 'noun',
          '["travel document"]'::jsonb, '["documento de viaje"]'::jsonb,
          'I need to renew my passport before traveling to London.',
          'Necesito renovar mi pasaporte antes de viajar a Londres.',
          'I need to renew my passport before traveling to London.',
          v_curated, v_examples)
  returning id into v_g1;

  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech)
  values (v_g, 'Maleta', 'Suitcase', 'Gear', 'noun')
  returning id into v_g2;

  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech) values
    (v_g, 'Billete', 'Ticket', 'Docs', 'noun'),
    (v_g, 'Andén', 'Platform', 'Places', 'noun'),
    (v_g, 'Aduana', 'Customs', 'Places', 'noun');

  insert into public.decks (slug, title, description, user_id, base_deck_id)
  values ('u-travel', 'Travel', 'Travel deck', '00000000-0000-0000-0000-000000000001', v_g)
  returning id into v_u;

  -- C1: clean copy of G1 — own examples/distractors EMPTY, provenance intact.
  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech,
                            synonyms_en, main_translations_es, example_sentence, example_es, example_en, base_card_id)
  values (v_u, 'Pasaporte', 'Passport', 'Docs', 'noun',
          '["travel document"]'::jsonb, '["documento de viaje"]'::jsonb,
          'I need to renew my passport before traveling to London.',
          'Necesito renovar mi pasaporte antes de viajar a Londres.',
          'I need to renew my passport before traveling to London.',
          v_g1);

  -- C2: copy of G1 whose ANSWER was edited — read-through must refuse.
  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech, base_card_id)
  values (v_u, 'Pase de viaje', 'Travel pass', 'Docs', 'noun', v_g1);

  -- C3: own curated distractors + own example pairs.
  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech,
                            example_sentence, example_es, example_en, cloze_distractors_en, examples)
  values (v_u, 'Reembolso', 'Refund', 'Money', 'noun',
          'The airline finally paid my refund after the cancelled flight.',
          'La aerolínea por fin pagó mi reembolso tras el vuelo cancelado.',
          'The airline finally paid my refund after the cancelled flight.',
          '["deposit", "discount", "receipt"]'::jsonb,
          '[
            {"es": "La aerolínea por fin pagó mi reembolso tras el vuelo cancelado.", "en": "The airline finally paid my refund after the cancelled flight."},
            {"es": "Pedí un reembolso porque el hotel canceló mi reserva.", "en": "I asked for a refund because the hotel cancelled my booking."},
            {"es": "El reembolso llegó a mi tarjeta en cinco días.", "en": "The refund reached my card in five days."}
          ]'::jsonb);

  -- C4: own distractors that ALL filter out (answer restatement, synonym,
  -- blank, duplicate) -> fewer than 2 usable -> sibling fallback.
  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech, synonyms_en, cloze_distractors_en)
  values (v_u, 'Propina', 'Tip', 'Money', 'noun',
          '["gratuity"]'::jsonb,
          '["Tip", "gratuity", "  ", "tip"]'::jsonb);

  -- C5: exactly 2 usable options -> served (>= MIN_MC_DISTRACTORS).
  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech, cloze_distractors_en)
  values (v_u, 'Horario', 'Timetable', 'Places', 'noun', '["menu", "map"]'::jsonb);

  -- C6: copy of G2, which has no curated content anywhere -> sibling fallback.
  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech, base_card_id)
  values (v_u, 'Maleta', 'Suitcase', 'Gear', 'noun', v_g2);

  -- Sibling pool for the user deck.
  insert into public.cards (deck_id, spanish_text, english_text, section_name, part_of_speech) values
    (v_u, 'Equipaje', 'Luggage', 'Gear', 'noun'),
    (v_u, 'Sello', 'Stamp', 'Docs', 'noun'),
    (v_u, 'Frontera', 'Border', 'Places', 'noun');
end $$;
