// Prompt builders for the card generator pipeline.
// Every builder returns { system, user, temperature }. The `user` content is a
// compact JSON document — light models follow an explicit schema + rules better
// than prose. Each enrichment builder accepts an optional `issues` array so the
// SAME builder is reused for targeted repair (re-run only the failing sub-prompt).

const PROMPT_VERSIONS = {
  blueprint: 'blueprint-v1',
  wordset: 'wordset-v1',
  lexical: 'enrich-lexical-v1',
  equivalents: 'enrich-equivalents-v1',
  examples: 'enrich-examples-v1',
};

function deckContext(spec) {
  return {
    title: spec.title,
    description: spec.description,
    topic: spec.topic || spec.title,
    difficulty: spec.difficulty || 'beginner',
    learner_profile: spec.learner_profile || 'Spanish-speaking learners of English',
    generation_notes: spec.generation_notes || '',
  };
}

function withIssues(doc, issues) {
  if (Array.isArray(issues) && issues.length) {
    doc.fix_these_issues = issues;
    doc.note = 'A previous attempt was rejected. Fix the listed issues and return corrected JSON only.';
  }
  return doc;
}

// ---- Stage 1: deck blueprint (sections) -----------------------------------
function blueprintPrompt(spec) {
  const system =
    'You design high-quality Spanish to English flashcard decks for Spanish-speaking learners of English. ' +
    'Return JSON only. Plan a coherent set of thematic sections that, together, cover the deck topic well.';
  const user = JSON.stringify({
    task: 'Plan the sections of a Spanish to English flashcard deck.',
    deck: deckContext(spec),
    target_total_cards: spec.target_card_count || 20,
    required_output: {
      sections: [
        { name: 'string', communicative_goal: 'string', lexical_focus: ['string'], target_card_count: 0 },
      ],
    },
    rules: [
      'Produce 2 to 6 sections.',
      'The sum of target_card_count across sections should equal target_total_cards.',
      'Each section needs 3 to 8 concrete lexical_focus keywords (in English).',
      'Sections must be communicatively distinct, not overlapping.',
      'Return JSON only, no commentary or markdown.',
    ],
  });
  return { system, user, temperature: 0.2 };
}

// ---- Stage 2: word-set draft for one section ------------------------------
function wordSetPrompt(spec, section, requestedCount, mustAvoidPairs) {
  const system =
    'You build Spanish to English flashcard word sets for Spanish-speaking learners of English. ' +
    'Return JSON only. Focus on a coherent, well-distributed set of pairs. ' +
    'Avoid duplicates, trivial variants, and near-synonyms.';
  const user = JSON.stringify({
    task: 'Generate Spanish to English flashcard pairs for one section.',
    deck: deckContext(spec),
    section: {
      name: section.name,
      communicative_goal: section.communicative_goal || '',
      lexical_focus: section.lexical_focus || [],
    },
    requested_count: requestedCount,
    must_avoid_pairs: (mustAvoidPairs || []).slice(0, 200),
    required_output: { cards: [{ spanish: 'string', english: 'string' }] },
    rules: [
      'Return up to the requested number of cards.',
      'Spanish is the prompt; English is the answer.',
      'Do not repeat any pair listed in must_avoid_pairs.',
      'Output only the spanish and english fields in this phase.',
      'Spread cards across the section lexical_focus; do not cluster on one subtopic.',
      'Prefer communicatively distinct cards over inflectional variants.',
      'Keep the English answer short, natural, and learner-friendly.',
      'Return JSON only, no commentary or markdown.',
    ],
  });
  return { system, user, temperature: 0.3 };
}

// ---- Stage 3a: lexical metadata (part_of_speech + definition_en) ----------
function lexicalPrompt(card, issues) {
  const system =
    'You add precise linguistic metadata to a single Spanish to English flashcard. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Provide part_of_speech and an English definition for the English answer.',
    card: { spanish: card.spanish_text, english: card.english_text },
    required_output: { part_of_speech: 'string', definition_en: 'string' },
    rules: [
      'part_of_speech describes the English answer (e.g. noun, verb, adjective, expression, question).',
      'definition_en is one concise, natural English sentence defining the English answer.',
      'Do not include Spanish text in either field.',
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.1 };
}

// ---- Stage 3b: equivalents (main_translations_es + collocations) ----------
function equivalentsPrompt(card, issues) {
  const system =
    'You add Spanish equivalents and English collocations to a single flashcard. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Provide Spanish translations of the prompt and English collocations for the answer.',
    card: { spanish: card.spanish_text, english: card.english_text },
    required_output: { main_translations_es: ['string'], collocations: ['string'] },
    rules: [
      'main_translations_es: 1 to 3 natural Spanish equivalents of the Spanish prompt (in Spanish).',
      'collocations: 2 to 4 common English phrases that use the English answer (in English).',
      'No duplicates within a list. Keep each item short.',
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.2 };
}

// ---- Stage 3c: examples (example_es + example_en) -------------------------
function examplesPrompt(card, issues) {
  const system =
    'You write a matched example sentence pair for a single Spanish to English flashcard. Return JSON only.';
  const user = JSON.stringify(withIssues({
    task: 'Write one Spanish example sentence and its English counterpart.',
    card: { spanish: card.spanish_text, english: card.english_text },
    required_output: { example_es: 'string', example_en: 'string' },
    rules: [
      'example_es is a natural Spanish sentence that uses the Spanish prompt.',
      'example_en is the English counterpart that uses the English answer naturally.',
      'The two sentences must mean the same thing.',
      'example_en must be in English (no inverted ¿ ¡ punctuation); example_es is in Spanish.',
      'Return JSON only, no commentary or markdown.',
    ],
  }, issues));
  return { system, user, temperature: 0.2 };
}

module.exports = {
  PROMPT_VERSIONS,
  blueprintPrompt,
  wordSetPrompt,
  lexicalPrompt,
  equivalentsPrompt,
  examplesPrompt,
};
