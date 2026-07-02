// Deterministic flashcard validators.
// validateCard() returns issues grouped by the enrichment sub-prompt responsible
// for fixing them ({ lexical, equivalents, examples, card }), so the generator can
// re-run ONLY the failing sub-prompt during repair. Empty arrays === valid.

const INVERTED_PUNCT = /[¿¡]/; // Spanish-only punctuation; must not appear in English fields

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function validateCard(card) {
  const issues = { lexical: [], equivalents: [], examples: [], mnemonic: [], card: [] };

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

  // --- examples (example_es + example_en) ---
  if (isBlank(card.example_es)) issues.examples.push('example_es is required');
  if (isBlank(card.example_en)) {
    issues.examples.push('example_en is required');
  } else if (INVERTED_PUNCT.test(card.example_en)) {
    issues.examples.push('example_en must be English (no ¿ or ¡)');
  }
  if (!isBlank(card.example_es) && !isBlank(card.example_en) &&
      card.example_es.trim().toLowerCase() === card.example_en.trim().toLowerCase()) {
    issues.examples.push('example_es and example_en must be different sentences');
  }

  // --- mnemonic (mnemonic_en) ---
  if (isBlank(card.mnemonic_en)) {
    issues.mnemonic.push('mnemonic_en is required');
  } else if (INVERTED_PUNCT.test(card.mnemonic_en)) {
    issues.mnemonic.push('mnemonic_en must be English (no ¿ or ¡)');
  } else if (String(card.mnemonic_en).length > 220) {
    issues.mnemonic.push('mnemonic_en must be one short sentence (max 220 chars)');
  }

  return issues;
}

function hasIssues(issues) {
  return Object.values(issues).some((arr) => arr.length > 0);
}

function flatten(issues) {
  return Object.values(issues).flat();
}

module.exports = { validateCard, hasIssues, flatten };
