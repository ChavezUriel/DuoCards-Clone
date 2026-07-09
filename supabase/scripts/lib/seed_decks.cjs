// Historical home of the 3 hand-authored starter decks (originally from
// backend/app/db.py). On 2026-07-08 their 15 cards were moved into
// supabase/seed_data/deck_expansions.json (prepended to the matching decks,
// preserving seed order) so update_cards.cjs / generate_cards.cjs can manage
// them like every other card — a .cjs module can't be written back by the
// pipeline. Kept as an empty list so the compilers/generators that merge
// SEED_DECKS first keep working unchanged; new hand-authored decks belong in
// seed_data JSON, not here.
module.exports = [];
