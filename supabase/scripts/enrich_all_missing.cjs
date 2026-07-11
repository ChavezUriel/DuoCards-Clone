#!/usr/bin/env node
// Runs `generate_cards.cjs enrich --only-missing --slug <slug>` for every deck
// (seed_data/*.json + the hand-authored lib/seed_decks.cjs) that still has at
// least one card with missing metadata. Skips decks that are already complete.
//
// Usage:
//   node supabase/scripts/enrich_all_missing.cjs                    # default model
//   node supabase/scripts/enrich_all_missing.cjs --model gpt-oss:120b-cloud
//   node supabase/scripts/enrich_all_missing.cjs --dry-run            # just list, don't run
//   node supabase/scripts/enrich_all_missing.cjs --max-repairs 3     # forwarded
//
// The underlying CLI reads the model / provider from the OLLAMA_MODEL /
// OLLAMA_PROVIDER / OLLAMA_API_KEY / OLLAMA_BASE_URL env vars (see
// lib/ollama.cjs), so this script forwards --model / --provider / --api-key /
// --base-url into those env vars before spawning.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { optText, normCard } = require('./lib/cards.cjs');
const { hasIssues } = require('./lib/validate.cjs');
const { cardStatus } = require('./lib/enrich.cjs');
const SEED_DECKS = require('./lib/seed_decks.cjs');

const DATA_DIR = path.resolve(__dirname, '../seed_data');
const GEN = path.resolve(__dirname, 'generate_cards.cjs');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}

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

// Collect every deck, de-duped by slug. Mirrors generate_cards.cjs#resolveDeck:
// seed_data files win, SEED_DECKS only fills slugs not present in any file (so
// the counts reported here match what the CLI will actually enrich).
const seen = new Set();
const decks = [];
for (const name of listExpansionFiles()) {
  for (const d of readJsonArray(path.join(DATA_DIR, name)) || []) {
    const slug = optText(d.slug);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    decks.push({ slug, source: 'file', title: d.title || slug, raw: d });
  }
}
for (const d of SEED_DECKS) {
  const slug = optText(d.slug);
  if (!slug || seen.has(slug)) continue;
  seen.add(slug);
  decks.push({ slug, source: 'seed', title: d.title || slug, raw: d });
}

// "Missing" mirrors generate_cards.cjs enrich --only-missing: deterministic
// field gaps PLUS stale/unpassed LLM audits (cardStatus), so a deck re-flags
// whenever the feature set or audited content moves.
function deckNeedsEnrich(deck) {
  const title = optText(deck.raw.title) || deck.slug;
  const deckCtx = { slug: deck.slug, title, description: optText(deck.raw.description) || '' };
  const cards = Array.isArray(deck.raw.cards) ? deck.raw.cards : [];
  let missing = 0;
  cards.forEach((c) => {
    const card = normCard(c, title);
    if (hasIssues(cardStatus(card, deckCtx))) missing++;
  });
  return { missing, total: cards.length };
}

const flags = parseArgs(process.argv.slice(2));
const model = optText(flags.model);
const provider = optText(flags.provider);
const apiKey = optText(flags['api-key']);
const baseUrl = optText(flags['base-url']);
const dryRun = !!flags['dry-run'];
const extraArgs = ['enrich', '--only-missing'];
if (flags['max-repairs'] !== undefined) {
  extraArgs.push('--max-repairs', String(flags['max-repairs']));
}

const env = { ...process.env };
if (model) env.OLLAMA_MODEL = model;
if (provider) env.OLLAMA_PROVIDER = provider;
if (apiKey) env.OLLAMA_API_KEY = apiKey;
if (baseUrl) env.OLLAMA_BASE_URL = baseUrl;

const targets = decks
  .map((d) => ({ ...d, ...deckNeedsEnrich(d) }))
  .filter((d) => d.missing > 0);

if (dryRun) {
  console.log(`--dry-run: ${targets.length} of ${decks.length} deck(s) have missing fields.`);
  for (const t of targets) {
    console.log(`  ${t.slug} (${t.source}): ${t.missing}/${t.total} card(s) need enrichment`);
  }
  process.exit(0);
}

if (!targets.length) {
  console.log('All decks are fully enriched — nothing to do.');
  process.exit(0);
}

console.log(`Enriching ${targets.length} deck(s)${model ? ` with model ${model}` : ''}${provider ? ` [provider ${provider}]` : ''}:`);
for (const t of targets) {
  console.log(`  - ${t.slug} (${t.missing}/${t.total} card(s) need work)`);
}
console.log('');

let failed = 0;
for (const t of targets) {
  console.log(`\n=== ${t.slug} ===`);
  const args = [...extraArgs, '--slug', t.slug];
  const result = spawnSync('node', [GEN, ...args], {
    stdio: 'inherit',
    env,
    cwd: path.resolve(__dirname, '..', '..'),
  });
  if (result.status !== 0) {
    failed++;
    console.error(`✗ ${t.slug} exited with status ${result.status}`);
  } else {
    console.log(`✓ ${t.slug} done`);
  }
}

console.log(`\nFinished: ${targets.length - failed}/${targets.length} ok, ${failed} failed.`);
process.exit(failed ? 1 : 0);