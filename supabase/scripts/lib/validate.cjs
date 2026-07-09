// Deterministic flashcard validators.
// validateCard() returns issues grouped by the enrichment sub-prompt responsible
// for fixing them ({ lexical, equivalents, examples, synonyms, clozeDistractors,
// card }), so the generator can re-run ONLY the failing sub-prompt during repair.
// Empty arrays === valid.
//
// mnemonic_en is no longer validated or generated (the memory-hook feature was
// removed from the app on 2026-07-08); existing values are still carried through
// to seed SQL untouched.
//
// LLM-judged quality (theme fit, blank inferability, cloze solvability) is NOT
// checked here — that lives in lib/enrich.cjs audits, which record pass results
// in card._audits.

const { locateAnswerInExample, normalizeAnswer } = require('./minigame_text.cjs');

const INVERTED_PUNCT = /[¿¡]/; // Spanish-only punctuation; must not appear in English fields

// Every card carries 3–4 matched example pairs (examples: [{es, en}]) so the
// fill-in-the-blank games can vary the sentence across presentations
// (migration 0019). The legacy example_es/example_en/example_sentence columns
// mirror pair 0 (lib/cards.cjs normCard keeps them in sync mechanically).
const EXAMPLES_MIN = 3;
const EXAMPLES_MAX = 4;

// The word-bank cloze needs 3 wrong options for a 4-tile round; 4 gives the
// distractor RPC room to vary repeat plays. Keep in sync with migration 0018
// (RPC uses >=2 curated as usable) and MIN_MC_DISTRACTORS in MinigameHost.jsx.
const CLOZE_DISTRACTORS_MIN = 3;
const CLOZE_DISTRACTORS_MAX = 4;

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function validateCard(card) {
  const issues = { lexical: [], equivalents: [], examples: [], synonyms: [], clozeDistractors: [], card: [] };

  // --- card-level ---
  if (isBlank(card.spanish_text)) issues.card.push('spanish_text is empty');
  if (isBlank(card.english_text)) issues.card.push('english_text is empty');
  if (!isBlank(card.spanish_text) && !isBlank(card.english_text) &&
      card.spanish_text.trim().toLowerCase() === card.english_text.trim().toLowerCase()) {
    issues.card.push('spanish_text and english_text must differ');
  }

  // --- lexical (part_of_speech + definition_en) ---
  if (isBlank(card.part_of_speech)) issues.lexical.push('part_of_speech is required');
  if (isBlank(card.definition_en)) {
    issues.lexical.push('definition_en is required');
  } else if (INVERTED_PUNCT.test(card.definition_en)) {
    issues.lexical.push('definition_en must be English (no ¿ or ¡)');
  }

  // --- equivalents (main_translations_es + collocations) ---
  const mts = Array.isArray(card.main_translations_es) ? card.main_translations_es : [];
  if (mts.length < 1 || mts.length > 3) {
    issues.equivalents.push('main_translations_es must contain 1 to 3 items');
  }
  const cols = Array.isArray(card.collocations) ? card.collocations : [];
  if (cols.length < 2 || cols.length > 4) {
    issues.equivalents.push('collocations must contain 2 to 4 items');
  }
  if (cols.some((c) => INVERTED_PUNCT.test(String(c)))) {
    issues.equivalents.push('collocations must be English phrases (no ¿ or ¡)');
  }

  // --- examples (examples: [{es, en}] + legacy mirror) ---
  const pairs = Array.isArray(card.examples) ? card.examples : [];
  if (pairs.length < EXAMPLES_MIN || pairs.length > EXAMPLES_MAX) {
    issues.examples.push(`examples must contain ${EXAMPLES_MIN} to ${EXAMPLES_MAX} sentence pairs`);
  }
  pairs.forEach((p, i) => {
    const es = p && p.es;
    const en = p && p.en;
    if (isBlank(es) || isBlank(en)) {
      issues.examples.push(`examples[${i}] needs both es and en sentences`);
      return;
    }
    if (INVERTED_PUNCT.test(en)) {
      issues.examples.push(`examples[${i}].en must be English (no ¿ or ¡)`);
    }
    if (es.trim().toLowerCase() === en.trim().toLowerCase()) {
      issues.examples.push(`examples[${i}] es and en must be different sentences`);
    }
    // Cloze eligibility: the app can only blank the answer out of a sentence
    // when it appears verbatim at word boundaries (same rule as the frontend's
    // locateAnswerInExample). Every stored pair must be blankable, so any of
    // them can back the fill-in-the-blank games.
    if (!isBlank(card.english_text) && locateAnswerInExample(en, card.english_text) === null) {
      issues.examples.push(`examples[${i}].en must contain the English answer verbatim (word for word) so it can be blanked`);
    }
  });
  const enNorms = pairs.map((p) => normalizeAnswer(String((p && p.en) ?? '')));
  if (new Set(enNorms.filter(Boolean)).size !== enNorms.length) {
    issues.examples.push('examples must not repeat the same English sentence');
  }
  // Legacy mirror: example_es/example_en/example_sentence must equal pair 0
  // (normCard repairs this mechanically; flagging covers hand-edited data that
  // bypassed normCard).
  if (pairs.length && pairs[0] && !isBlank(pairs[0].en)) {
    if (card.example_en !== pairs[0].en || card.example_es !== pairs[0].es ||
        card.example_sentence !== pairs[0].en) {
      issues.examples.push('example_es/example_en/example_sentence must mirror examples[0]');
    }
  } else if (pairs.length === 0) {
    // No pair set at all: keep the legacy fields' own sanity checks so partially
    // migrated data still reports something actionable.
    if (isBlank(card.example_es)) issues.examples.push('example_es is required');
    if (isBlank(card.example_en)) issues.examples.push('example_en is required');
  }

  // --- synonyms (synonyms_en) ---
  const syn = Array.isArray(card.synonyms_en) ? card.synonyms_en : [];
  if (syn.length < 1 || syn.length > 3) {
    issues.synonyms.push('synonyms_en must contain 1 to 3 items');
  }
  if (syn.some((s) => INVERTED_PUNCT.test(String(s)))) {
    issues.synonyms.push('synonyms_en must be English (no ¿ or ¡)');
  }

  // --- cloze distractors (cloze_distractors_en, migration 0018) ---
  // Deterministic shape checks only; whether a distractor secretly fits a
  // blank is judged by the clozeSolve audit in lib/enrich.cjs (per sentence).
  const opts = Array.isArray(card.cloze_distractors_en) ? card.cloze_distractors_en : [];
  if (opts.length < CLOZE_DISTRACTORS_MIN || opts.length > CLOZE_DISTRACTORS_MAX) {
    issues.clozeDistractors.push(`cloze_distractors_en must contain ${CLOZE_DISTRACTORS_MIN} to ${CLOZE_DISTRACTORS_MAX} items`);
  }
  if (opts.some((o) => INVERTED_PUNCT.test(String(o)))) {
    issues.clozeDistractors.push('cloze_distractors_en must be English (no ¿ or ¡)');
  }
  if (opts.some((o) => String(o).length > 60)) {
    issues.clozeDistractors.push('each cloze distractor must stay short (max 60 chars)');
  }
  const normOpts = opts.map((o) => normalizeAnswer(String(o)));
  if (new Set(normOpts.filter(Boolean)).size !== normOpts.length) {
    issues.clozeDistractors.push('cloze_distractors_en must not contain blanks or duplicates');
  }
  // A distractor restating the answer or a synonym would make two options
  // "correct"; one already present in any example sentence reads as broken.
  const answerForms = new Set(
    [card.english_text, ...syn].map((s) => normalizeAnswer(String(s ?? ''))).filter(Boolean),
  );
  if (normOpts.some((o) => answerForms.has(o))) {
    issues.clozeDistractors.push('cloze_distractors_en must not restate the answer or its synonyms');
  }
  const sentences = pairs.length
    ? pairs.map((p) => (p && p.en) || '')
    : [card.example_en].filter((s) => !isBlank(s));
  if (opts.some((o) => sentences.some((en) => !isBlank(en) && locateAnswerInExample(en, String(o)) !== null))) {
    issues.clozeDistractors.push('cloze_distractors_en must not reuse a word already present in an example sentence');
  }

  return issues;
}

function hasIssues(issues) {
  return Object.values(issues).some((arr) => arr.length > 0);
}

function flatten(issues) {
  return Object.values(issues).flat();
}

module.exports = {
  validateCard, hasIssues, flatten,
  EXAMPLES_MIN, EXAMPLES_MAX,
  CLOZE_DISTRACTORS_MIN, CLOZE_DISTRACTORS_MAX,
};
