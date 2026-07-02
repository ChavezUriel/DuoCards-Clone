// Shared card normalization + dedup helpers.
// Used by both generate_seed.cjs (compiles seed.sql) and generate_cards.cjs
// (the AI generator) so the generator always emits exactly what the seed
// compiler accepts. Keep this dependency-free (pure Node).

function optText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normList(v) {
  if (!Array.isArray(v)) return [];
  const out = [], seen = new Set();
  for (const item of v) {
    const s = optText(item);
    if (s === null) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// Normalize one authored/generated card into the enriched seed shape.
// Accepts either {spanish, english} (draft) or the fully enriched object.
function normCard(card, deckTitle) {
  const spanish = optText(card.spanish ?? card.prompt_es);
  const english = optText(card.english ?? card.answer_en);
  if (!spanish || !english) throw new Error('card missing spanish/english: ' + JSON.stringify(card));
  return {
    spanish_text: spanish,
    english_text: english,
    section_name: optText(card.section_name) ?? deckTitle,
    part_of_speech: optText(card.part_of_speech),
    definition_en: optText(card.definition_en),
    main_translations_es: normList(card.main_translations_es),
    collocations: normList(card.collocations),
    example_sentence: optText(card.example_sentence),
    example_es: optText(card.example_es),
    example_en: optText(card.example_en),
    mnemonic_en: optText(card.mnemonic_en),
  };
}

// Case-insensitive dedup key for a (spanish, english) pair.
function pairKey(spanish, english) {
  return String(spanish).toLowerCase() + ' ' + String(english).toLowerCase();
}

module.exports = { optText, normList, normCard, pairKey };
