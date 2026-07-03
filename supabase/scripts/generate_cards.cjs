#!/usr/bin/env node
// AI flashcard generator for DuoCards Clone (Ollama gpt-oss:20b).
//
// Produces / enriches Spanish->English flashcards in the enriched seed-JSON shape
// that supabase/scripts/generate_seed.cjs consumes. Apply with:
//   node supabase/scripts/generate_cards.cjs <command> ...   # write seed_data/*.json
//   node supabase/scripts/generate_seed.cjs                   # compile seed.sql
//
// Commands:
//   generate --spec <file>            Create a new deck from a topic spec.
//   enrich   --slug <slug>            Fill metadata on an existing seed_data deck.
//   review   --slug <slug>            Validate an existing deck; report issues.
//
// Common flags:
//   --limit N        Cap the number of cards processed (cheap smoke tests).
//   --preview        Print results; do NOT write any file.
//   --only-missing   (enrich) Only enrich cards missing metadata. Default: all.
//   --repair         (review) Re-run failing sub-prompts and rewrite the deck.
//   --max-repairs N  Repair attempts per card (default 2).
//   --out <file>     (generate) Output file (default: deck_expansions_generated.json).
//
// Quality strategy: light model => many small focused prompts. Each card is
// enriched with 3 separate sub-prompts (lexical / equivalents / examples), then
// validated; only the failing sub-prompt is re-run during repair.

const fs = require('fs');
const path = require('path');
const { chatJson, MODEL, BASE_URL } = require('./lib/ollama.cjs');
const {
  blueprintPrompt, wordSetPrompt, lexicalPrompt, equivalentsPrompt, examplesPrompt, mnemonicPrompt, synonymsPrompt, PROMPT_VERSIONS,
} = require('./lib/prompts.cjs');
const { validateCard, hasIssues, flatten } = require('./lib/validate.cjs');
const { optText, normList, normCard, pairKey } = require('./lib/cards.cjs');
const SEED_DECKS = require('./lib/seed_decks.cjs');

const DATA_DIR = path.resolve(__dirname, '../seed_data');
const GENERATED_FILE = path.join(DATA_DIR, 'deck_expansions_generated.json');

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// seed_data file IO
// ---------------------------------------------------------------------------
function listExpansionFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /^deck_expansions.*\.json$/.test(f))
    .sort();
}

function readJsonArray(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(payload)) throw new Error(`${path.basename(file)} must be a JSON array`);
  return payload;
}

// Find a deck by slug: search seed_data files first (writable), then SEED_DECKS.
function resolveDeck(slug) {
  for (const name of listExpansionFiles()) {
    const file = path.join(DATA_DIR, name);
    const arr = readJsonArray(file);
    const idx = arr.findIndex((d) => optText(d.slug) === slug);
    if (idx !== -1) return { source: 'file', file, array: arr, index: idx, deck: arr[idx] };
  }
  const seed = SEED_DECKS.find((d) => optText(d.slug) === slug);
  if (seed) return { source: 'seed', deck: seed };
  return null;
}

// Upsert a single deck entry (by slug) into an array-shaped seed_data file.
function upsertDeckFile(file, deckEntry) {
  let arr = [];
  if (fs.existsSync(file)) arr = readJsonArray(file);
  const idx = arr.findIndex((d) => optText(d.slug) === deckEntry.slug);
  if (idx === -1) arr.push(deckEntry); else arr[idx] = deckEntry;
  fs.writeFileSync(file, JSON.stringify(arr, null, 2) + '\n', 'utf8');
}

// Enriched working card (spanish_text/...) -> seed-JSON card (spanish/english/...).
function toSeedCard(card) {
  const out = { spanish: card.spanish_text, english: card.english_text };
  if (optText(card.section_name)) out.section_name = card.section_name;
  if (optText(card.part_of_speech)) out.part_of_speech = card.part_of_speech;
  if (optText(card.definition_en)) out.definition_en = card.definition_en;
  out.main_translations_es = normList(card.main_translations_es);
  out.collocations = normList(card.collocations);
  out.synonyms_en = normList(card.synonyms_en);
  // example_sentence mirrors the English example (the column the app reads).
  if (optText(card.example_en)) out.example_sentence = card.example_en;
  if (optText(card.example_es)) out.example_es = card.example_es;
  if (optText(card.example_en)) out.example_en = card.example_en;
  if (optText(card.mnemonic_en)) out.mnemonic_en = card.mnemonic_en;
  return out;
}

// ---------------------------------------------------------------------------
// pipeline stages
// ---------------------------------------------------------------------------
async function buildBlueprint(spec) {
  if (Array.isArray(spec.sections) && spec.sections.length) {
    log(`Blueprint: using ${spec.sections.length} section(s) from spec.`);
    return spec.sections;
  }
  log('Blueprint: planning sections with the model...');
  const { system, user, temperature } = blueprintPrompt(spec);
  const resp = await chatJson({ system, user, temperature });
  const sections = Array.isArray(resp.sections) ? resp.sections : [];
  if (!sections.length) {
    // Fall back to a single catch-all section.
    return [{ name: spec.title, communicative_goal: spec.topic || spec.title, lexical_focus: [], target_card_count: spec.target_card_count || 20 }];
  }
  return sections;
}

async function generateWordSet(spec, sections, totalTarget) {
  const cards = [];
  const seen = new Set();
  for (const section of sections) {
    if (cards.length >= totalTarget) break;
    const remaining = totalTarget - cards.length;
    const want = Math.min(remaining, Number(section.target_card_count) || remaining);
    if (want <= 0) continue;
    const mustAvoid = cards.map((c) => `${c.spanish_text} -> ${c.english_text}`);
    log(`  Word set: section "${section.name}" requesting ${want} card(s)...`);
    const { system, user, temperature } = wordSetPrompt(spec, section, want, mustAvoid);
    const resp = await chatJson({ system, user, temperature });
    const raw = Array.isArray(resp.cards) ? resp.cards : [];
    for (const rc of raw) {
      const spanish = optText(rc.spanish);
      const english = optText(rc.english);
      if (!spanish || !english) continue;
      const key = pairKey(spanish, english);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({ spanish_text: spanish, english_text: english, section_name: optText(section.name) || spec.title });
      if (cards.length >= totalTarget) break;
    }
  }
  return cards;
}

function applyLexical(card, resp) {
  card.part_of_speech = optText(resp.part_of_speech);
  card.definition_en = optText(resp.definition_en);
}
function applyEquivalents(card, resp) {
  card.main_translations_es = normList(resp.main_translations_es).slice(0, 3);
  card.collocations = normList(resp.collocations).slice(0, 4);
}
function applyExamples(card, resp) {
  card.example_es = optText(resp.example_es);
  card.example_en = optText(resp.example_en);
}
function applyMnemonic(card, resp) {
  card.mnemonic_en = optText(resp.mnemonic_en);
}
function applySynonyms(card, resp) {
  card.synonyms_en = normList(resp.synonyms_en).slice(0, 3);
}

// Enrich a single card with up to 4 focused sub-prompts + targeted repair.
// Only the sub-prompts whose fields are missing/invalid run: fresh drafts get
// the full pipeline, while already-enriched cards just fill the gaps (e.g. a
// newly added mnemonic) without overwriting curated metadata.
async function enrichCard(draft, maxRepairs) {
  const card = { ...draft };

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const issues = validateCard(card);
    if (!hasIssues(issues)) break;
    // card-level issues (spanish/english) cannot be fixed by enrichment.
    if (issues.card.length) break;
    const hint = (arr) => (attempt === 0 ? undefined : arr);
    if (issues.lexical.length) applyLexical(card, await runPrompt(lexicalPrompt(card, hint(issues.lexical))));
    if (issues.equivalents.length) applyEquivalents(card, await runPrompt(equivalentsPrompt(card, hint(issues.equivalents))));
    if (issues.examples.length) applyExamples(card, await runPrompt(examplesPrompt(card, hint(issues.examples))));
    if (issues.mnemonic.length) applyMnemonic(card, await runPrompt(mnemonicPrompt(card, hint(issues.mnemonic))));
    if (issues.synonyms.length) applySynonyms(card, await runPrompt(synonymsPrompt(card, hint(issues.synonyms))));
  }

  return { card, issues: validateCard(card) };
}

function runPrompt(p) {
  return chatJson({ system: p.system, user: p.user, temperature: p.temperature });
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
async function cmdGenerate(flags) {
  if (!flags.spec) throw new Error('generate requires --spec <file>');
  const specPath = path.isAbsolute(flags.spec) ? flags.spec : path.resolve(process.cwd(), flags.spec);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  for (const k of ['slug', 'title', 'description']) {
    if (!optText(spec[k])) throw new Error(`spec is missing required field: ${k}`);
  }
  const limit = flags.limit ? Number(flags.limit) : null;
  const totalTarget = limit || Number(spec.target_card_count) || 20;
  const maxRepairs = flags['max-repairs'] !== undefined ? Number(flags['max-repairs']) : 2;

  log(`\nGenerating deck "${spec.slug}" (${MODEL} @ ${BASE_URL}), target ${totalTarget} card(s).`);
  const sections = await buildBlueprint(spec);
  const drafts = await generateWordSet(spec, sections, totalTarget);
  log(`Drafted ${drafts.length} card(s). Enriching (3 sub-prompts each)...`);

  const enriched = [];
  const rejected = [];
  for (let i = 0; i < drafts.length; i++) {
    log(`  [${i + 1}/${drafts.length}] ${drafts[i].spanish_text} -> ${drafts[i].english_text}`);
    const t0 = Date.now();
    const { card, issues } = await enrichCard(drafts[i], maxRepairs);
    log(`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (hasIssues(issues)) rejected.push({ card, issues: flatten(issues) });
    else enriched.push(card);
  }

  const deckEntry = {
    slug: spec.slug,
    title: spec.title,
    description: spec.description,
    language_from: optText(spec.language_from) || 'es',
    language_to: optText(spec.language_to) || 'en',
    _meta: {
      generated_by: MODEL,
      generated_at: new Date().toISOString(),
      prompt_versions: PROMPT_VERSIONS,
    },
    cards: enriched.map(toSeedCard),
  };

  reportRejected(rejected);
  log(`\nDeck "${spec.slug}": ${enriched.length} enriched, ${rejected.length} rejected.`);

  if (flags.preview) {
    log('\n--- PREVIEW (no file written) ---');
    log(JSON.stringify(deckEntry, null, 2));
    return;
  }
  const outFile = flags.out
    ? (path.isAbsolute(flags.out) ? flags.out : path.resolve(process.cwd(), flags.out))
    : GENERATED_FILE;
  upsertDeckFile(outFile, deckEntry);
  log(`\nWrote deck "${spec.slug}" to ${outFile}`);
  log('Next: node supabase/scripts/generate_seed.cjs  (compile seed.sql)');
}

function cardNeedsEnrichment(card) {
  return hasIssues(validateCard(card));
}

async function cmdEnrich(flags) {
  if (!flags.slug) throw new Error('enrich requires --slug <slug>');
  const resolved = resolveDeck(flags.slug);
  if (!resolved) throw new Error(`Deck not found in seed_data or starter decks: ${flags.slug}`);
  if (resolved.source === 'seed') {
    throw new Error(`Deck "${flags.slug}" is defined in lib/seed_decks.cjs (already enriched). Edit it there, or move it to seed_data to enrich.`);
  }
  const deck = resolved.deck;
  const title = optText(deck.title) || flags.slug;
  const rawCards = Array.isArray(deck.cards) ? deck.cards : [];
  const maxRepairs = flags['max-repairs'] !== undefined ? Number(flags['max-repairs']) : 2;
  const onlyMissing = !!flags['only-missing'];
  const limit = flags.limit ? Number(flags.limit) : null;

  // Normalize existing cards, decide which to (re)enrich.
  const working = rawCards.map((rc) => normCard(rc, title));
  let targets = working.map((c, idx) => ({ c, idx }));
  if (onlyMissing) targets = targets.filter(({ c }) => cardNeedsEnrichment(c));
  if (limit) targets = targets.slice(0, limit);

  log(`\nEnriching deck "${flags.slug}" in ${path.basename(resolved.file)}: ${targets.length} of ${working.length} card(s) (${MODEL}).`);

  const rejected = [];
  for (let t = 0; t < targets.length; t++) {
    const { c, idx } = targets[t];
    log(`  [${t + 1}/${targets.length}] ${c.spanish_text} -> ${c.english_text}`);
    const t0 = Date.now();
    const { card, issues } = await enrichCard(c, maxRepairs);
    log(`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    working[idx] = card; // replace in place (keeps card order)
    if (hasIssues(issues)) rejected.push({ card, issues: flatten(issues) });
  }
  reportRejected(rejected);

  const newCards = working.map(toSeedCard);
  if (flags.preview) {
    log('\n--- PREVIEW (no file written) ---');
    log(JSON.stringify(newCards, null, 2));
    return;
  }
  resolved.array[resolved.index] = {
    ...deck,
    cards: newCards,
  };
  fs.writeFileSync(resolved.file, JSON.stringify(resolved.array, null, 2) + '\n', 'utf8');
  log(`\nUpdated ${targets.length} card(s) in ${resolved.file}`);
  log('Next: node supabase/scripts/generate_seed.cjs  (compile seed.sql)');
}

async function cmdReview(flags) {
  if (!flags.slug) throw new Error('review requires --slug <slug>');
  const resolved = resolveDeck(flags.slug);
  if (!resolved) throw new Error(`Deck not found: ${flags.slug}`);
  const deck = resolved.deck;
  const title = optText(deck.title) || flags.slug;
  const working = (Array.isArray(deck.cards) ? deck.cards : []).map((rc) => normCard(rc, title));

  let bad = 0;
  log(`\nReviewing deck "${flags.slug}" (${working.length} cards, source: ${resolved.source}).`);
  const failing = [];
  working.forEach((card, i) => {
    const issues = validateCard(card);
    if (hasIssues(issues)) {
      bad++;
      failing.push(i);
      log(`  ✗ [${i + 1}] ${card.spanish_text} -> ${card.english_text}`);
      flatten(issues).forEach((m) => log(`      - ${m}`));
    }
  });
  log(`\n${working.length - bad}/${working.length} cards OK, ${bad} with issues.`);

  if (bad && flags.repair) {
    if (resolved.source !== 'file') {
      log('Cannot --repair: deck is defined in lib/seed_decks.cjs, not seed_data.');
      return;
    }
    const maxRepairs = flags['max-repairs'] !== undefined ? Number(flags['max-repairs']) : 2;
    log(`\nRepairing ${failing.length} card(s)...`);
    for (const i of failing) {
      log(`  ${working[i].spanish_text} -> ${working[i].english_text}`);
      const t0 = Date.now();
      const { card } = await enrichCard(working[i], maxRepairs);
      log(`    done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      working[i] = card;
    }
    resolved.array[resolved.index] = { ...deck, cards: working.map(toSeedCard) };
    fs.writeFileSync(resolved.file, JSON.stringify(resolved.array, null, 2) + '\n', 'utf8');
    log(`\nRewrote ${resolved.file}`);
    log('Next: node supabase/scripts/generate_seed.cjs  (compile seed.sql)');
  }
}

function reportRejected(rejected) {
  if (!rejected.length) return;
  log(`\n${rejected.length} card(s) still have issues after repair:`);
  for (const r of rejected) {
    log(`  ✗ ${r.card.spanish_text} -> ${r.card.english_text}: ${r.issues.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
async function main() {
  const command = process.argv[2];
  const flags = parseArgs(process.argv.slice(3));
  switch (command) {
    case 'generate': return cmdGenerate(flags);
    case 'enrich': return cmdEnrich(flags);
    case 'review': return cmdReview(flags);
    default:
      log('Usage: node supabase/scripts/generate_cards.cjs <generate|enrich|review> [flags]');
      log('  generate --spec <file> [--limit N] [--preview] [--out <file>] [--max-repairs N]');
      log('  enrich   --slug <slug> [--only-missing] [--limit N] [--preview] [--max-repairs N]');
      log('  review   --slug <slug> [--repair] [--max-repairs N]');
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
