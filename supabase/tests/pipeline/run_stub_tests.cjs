#!/usr/bin/env node
// Offline tests for the enrichment/audit pipeline (lib/enrich.cjs + friends).
// No Ollama needed: processCard() takes a runPrompt injection, so these stubs
// script the model's answers and assert on the resulting card + call pattern.
//
//   node supabase/tests/pipeline/run_stub_tests.cjs

const assert = require('assert');
const path = require('path');
const LIB = path.resolve(__dirname, '../../scripts/lib');
const { processCard, cardStatus } = require(path.join(LIB, 'enrich.cjs'));
const { validateCard, flatten } = require(path.join(LIB, 'validate.cjs'));
const { locateAnswerInExample } = require(path.join(LIB, 'minigame_text.cjs'));
const { normCard } = require(path.join(LIB, 'cards.cjs'));

const DECK = { slug: 'travel', title: 'Travel Phrases', description: 'Short phrases for transport, directions, and common travel moments.' };

// Identify which prompt builder produced a request by its user-JSON `task`.
function kindOf(p) {
  const task = JSON.parse(p.user).task;
  if (task.startsWith('Provide part_of_speech')) return 'lexical';
  if (task.startsWith('Provide Spanish translations')) return 'equivalents';
  if (task.startsWith('Write Spanish example sentences')) return 'examples';
  if (task.startsWith('Rewrite this example sentence pair')) return 'rewrite';
  if (task.startsWith('Provide English synonyms')) return 'synonyms';
  if (task.startsWith('Write challenging but clearly wrong options')) return 'distractors';
  if (task.startsWith('Audit one example sentence pair')) return 'exampleAudit';
  if (task.startsWith('Decide which of the offered options')) return 'clozeSolve';
  throw new Error('unknown prompt task: ' + task);
}

// Scripted model: `script` maps kind -> array of responses (or a function of
// the parsed user doc), consumed in call order; the last entry repeats.
function makeStub(script, calls) {
  return async (p) => {
    const kind = kindOf(p);
    calls.push(kind);
    const entries = script[kind];
    if (!entries) throw new Error(`stub has no script for ${kind}`);
    const i = Math.min(calls.filter((c) => c === kind).length - 1, entries.length - 1);
    const entry = entries[i];
    return typeof entry === 'function' ? entry(JSON.parse(p.user)) : entry;
  };
}

const PAIRS = [
  { example_es: 'Necesito renovar mi pasaporte antes de viajar a Londres.', example_en: 'I need to renew my passport before traveling to London.' },
  { example_es: 'El agente selló mi pasaporte en el control.', example_en: 'The border agent stamped my passport at the checkpoint.' },
  { example_es: 'Revisaron cada pasaporte antes de subir al ferry.', example_en: 'Officials checked every passport before we got on the ferry.' },
];
const PASS_AUDIT = { theme_fit: 'pass', blank_inferable: 'pass', issues: [] };
const solveOnly = (words) => (u) => ({ fitting_options: u.exercise.options.filter((o) => words.includes(o)) });

const BASE_SCRIPT = {
  lexical: [{ part_of_speech: 'noun', definition_en: 'An official travel document.' }],
  equivalents: [{ main_translations_es: ['documento de viaje'], collocations: ['passport control', 'passport photo'] }],
  examples: [{ examples: PAIRS }],
  rewrite: [],
  synonyms: [{ synonyms_en: ['travel document'] }],
  // 5 candidates; the applier must drop the answer restatement.
  distractors: [{ cloze_distractors_en: ['visa', 'ticket', 'suitcase', 'boarding pass', 'Passport'] }],
  exampleAudit: [PASS_AUDIT],
  clozeSolve: [solveOnly(['Passport'])],
};

const DRAFT = { spanish_text: 'Pasaporte', english_text: 'Passport' };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('pipeline stub tests');

  await test('T1 fresh draft: 3 pairs generated, per-pair audits + per-sentence solves pass', async () => {
    const calls = [];
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, calls) });
    assert.deepStrictEqual(flatten(issues), [], 'final card must be clean: ' + flatten(issues));
    assert.strictEqual(card.examples.length, 3);
    assert.strictEqual(card.example_en, PAIRS[0].example_en, 'legacy mirror = pair 0');
    assert.strictEqual(card.example_sentence, PAIRS[0].example_en);
    assert.deepStrictEqual(card.cloze_distractors_en, ['visa', 'ticket', 'suitcase', 'boarding pass']);
    assert.ok(card._audits.example_quality?.status === 'pass');
    assert.ok(card._audits.cloze_options?.status === 'pass');
    assert.strictEqual(calls.filter((c) => c === 'examples').length, 1);
    assert.strictEqual(calls.filter((c) => c === 'exampleAudit').length, 3, 'one audit per pair');
    assert.strictEqual(calls.filter((c) => c === 'clozeSolve').length, 3, 'one solve per sentence');
    assert.strictEqual(calls.filter((c) => c === 'distractors').length, 1);
  });

  await test('T2 audit rejects ONE pair -> only that pair rewritten, siblings kept', async () => {
    const calls = [];
    const fixedPair = { example_es: 'Mostré mi pasaporte azul en la aduana.', example_en: 'I showed my blue passport at customs.' };
    const script = {
      ...BASE_SCRIPT,
      examples: [{ examples: [{ example_es: 'Me gusta mi pasaporte.', example_en: 'I like my passport.' }, PAIRS[1], PAIRS[2]] }],
      rewrite: [fixedPair],
      // Sweep 1: pair 0 fails, 1-2 pass. Sweep 2 (after rewrite): all pass.
      exampleAudit: [
        { theme_fit: 'pass', blank_inferable: 'fail', issues: ['add context that points to the missing word'] },
        PASS_AUDIT, PASS_AUDIT, PASS_AUDIT, PASS_AUDIT, PASS_AUDIT,
      ],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.strictEqual(calls.filter((c) => c === 'examples').length, 1, 'full set generated once');
    assert.strictEqual(calls.filter((c) => c === 'rewrite').length, 1, 'exactly one pair rewritten');
    assert.strictEqual(card.examples[0].en, fixedPair.example_en, 'rejected pair replaced');
    assert.strictEqual(card.example_en, fixedPair.example_en, 'legacy mirror follows pair 0');
    assert.strictEqual(card.examples[1].en, PAIRS[1].example_en, 'good pairs untouched');
    assert.ok(card._audits.example_quality?.status === 'pass');
  });

  await test('T3 solve flags an option in ONE sentence -> pruned, survivors accepted without regen', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      clozeSolve: [(u) => ({
        fitting_options: u.exercise.options.filter((o) =>
          o === 'Passport' || (o === 'visa' && u.exercise.sentence_with_blank.includes('border agent'))),
      })],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.deepStrictEqual(card.cloze_distractors_en, ['ticket', 'suitcase', 'boarding pass'], 'union offender pruned');
    assert.strictEqual(calls.filter((c) => c === 'distractors').length, 1, 'no regeneration needed');
    assert.ok(card._audits.cloze_options?.status === 'pass');
  });

  await test('T4 too many options fit -> full distractor regeneration with feedback', async () => {
    const calls = [];
    const script = {
      ...BASE_SCRIPT,
      distractors: [
        { cloze_distractors_en: ['visa', 'ID card', 'permit', 'licence', 'certificate'] },
        { cloze_distractors_en: ['suitcase', 'pillow', 'sandwich', 'umbrella'] },
      ],
      clozeSolve: [
        solveOnly(['Passport', 'visa', 'ID card', 'permit']),
        solveOnly(['Passport', 'visa', 'ID card', 'permit']),
        solveOnly(['Passport', 'visa', 'ID card', 'permit']),
        solveOnly(['Passport']),
      ],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.deepStrictEqual(card.cloze_distractors_en, ['suitcase', 'pillow', 'sandwich', 'umbrella']);
    assert.strictEqual(calls.filter((c) => c === 'distractors').length, 2, 'regenerated once');
    assert.ok(card._audits.cloze_options?.status === 'pass');
  });

  await test('T5 examiner rejects the answer in one sentence -> that pair rewritten', async () => {
    const calls = [];
    const fixedPair = { example_es: 'Enseñé mi pasaporte al embarcar.', example_en: 'I showed my passport when boarding the plane.' };
    const script = {
      ...BASE_SCRIPT,
      rewrite: [fixedPair],
      clozeSolve: [
        solveOnly(['Passport']),
        solveOnly(['Passport']),
        solveOnly([]),          // sentence 3: answer not accepted
        solveOnly(['Passport']),
        solveOnly(['Passport']),
        solveOnly(['Passport']),
      ],
    };
    const { card, issues } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(script, calls) });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.strictEqual(calls.filter((c) => c === 'rewrite').length, 1);
    assert.strictEqual(card.examples[2].en, fixedPair.example_en, 'offending sentence replaced');
  });

  await test('T6 finished card: re-run makes zero LLM calls (fingerprint skip)', async () => {
    const calls = [];
    const { card } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, calls) });
    const { issues } = await processCard(card, {
      deck: DECK,
      runPrompt: async () => { throw new Error('must not be called'); },
    });
    assert.deepStrictEqual(flatten(issues), []);
  });

  await test('T7 content edits re-flag audits; blankability stays deterministic', async () => {
    const calls = [];
    const { card } = await processCard({ ...DRAFT }, { deck: DECK, runPrompt: makeStub(BASE_SCRIPT, calls) });
    const edited = {
      ...card,
      examples: [{ es: card.examples[0].es, en: 'I must renew my passport before my trip to Paris.' }, ...card.examples.slice(1)],
    };
    edited.example_en = edited.examples[0].en;
    edited.example_sentence = edited.examples[0].en;
    assert.ok(cardStatus(edited, DECK).audits.length >= 1, 'edited sentence must re-flag audits');
    const broken = { ...card, examples: [{ es: 'x', en: 'She renewed her passports yesterday.' }, ...card.examples.slice(1)] };
    assert.ok(validateCard(broken).examples.some((m) => m.includes('verbatim')), 'inflected answer must flag');
  });

  await test('T8 legacy single-example card seeds the pair set and reaches 3 pairs', async () => {
    const legacy = normCard({
      spanish: 'Pasaporte', english: 'Passport', part_of_speech: 'noun',
      definition_en: 'An official travel document.',
      main_translations_es: ['documento'], collocations: ['passport control', 'passport photo'],
      synonyms_en: ['travel document'],
      example_es: PAIRS[0].example_es, example_en: PAIRS[0].example_en, example_sentence: PAIRS[0].example_en,
    }, 'Travel Phrases');
    assert.strictEqual(legacy.examples.length, 1, 'legacy pair seeds examples');
    assert.ok(validateCard(legacy).examples.some((m) => m.includes('3 to 4')), 'needs more pairs');
    const calls = [];
    let sawExisting = null;
    const stub = makeStub(BASE_SCRIPT, calls);
    const spy = async (p) => {
      if (kindOf(p) === 'examples') sawExisting = JSON.parse(p.user).existing_examples;
      return stub(p);
    };
    const { card, issues } = await processCard(legacy, { deck: DECK, runPrompt: spy });
    assert.deepStrictEqual(flatten(issues), [], flatten(issues).join('; '));
    assert.strictEqual(card.examples.length, 3);
    assert.deepStrictEqual(sawExisting, [{ example_es: PAIRS[0].example_es, example_en: PAIRS[0].example_en }],
      'prompt saw the legacy pair as keepable');
  });

  await test('T9 validator: distractor shape rules across all sentences', async () => {
    const base = {
      ...DRAFT, part_of_speech: 'noun', definition_en: 'd',
      main_translations_es: ['x'], collocations: ['a', 'b'], synonyms_en: ['travel document'],
      examples: PAIRS.map((p) => ({ es: p.example_es, en: p.example_en })),
      example_es: PAIRS[0].example_es, example_en: PAIRS[0].example_en, example_sentence: PAIRS[0].example_en,
    };
    assert.deepStrictEqual(validateCard({ ...base, cloze_distractors_en: ['visa', 'ticket', 'suitcase'] }).clozeDistractors, []);
    assert.ok(validateCard({ ...base, cloze_distractors_en: [] }).clozeDistractors.length, 'empty set flags');
    assert.ok(validateCard({ ...base, cloze_distractors_en: ['visa', 'ticket', 'travel document'] }).clozeDistractors
      .some((m) => m.includes('restate')), 'synonym restatement flags');
    assert.ok(validateCard({ ...base, cloze_distractors_en: ['visa', 'ticket', 'ferry'] }).clozeDistractors
      .some((m) => m.includes('already present')), 'word from ANY sentence flags');
    assert.ok(validateCard({ ...base, examples: base.examples.slice(0, 2) }).examples
      .some((m) => m.includes('3 to 4')), 'fewer than 3 pairs flags');
  });

  await test('T10 cloze span mirror matches multi-word + diacritic cases', async () => {
    assert.ok(locateAnswerInExample('Excuse me, where is the station, please?', 'Where is the station?'));
    assert.ok(locateAnswerInExample('Se dice: ¿dónde está la estación?', 'Dónde esta la estacion'));
    assert.strictEqual(locateAnswerInExample('I gave up quickly.', 'give up'), null);
  });

  console.log(`\nALL ${passed} STUB TESTS PASSED`);
})().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  process.exit(1);
});
