# AI deck builder (in-app)

Lets a signed-in learner generate a personal deck with **their own** provider API
key, from a specification they can write as a form or as YAML, and watch the run
card by card before saving it into their decks.

It is the browser sibling of the Node CLI in
[`supabase/scripts/generate_cards.cjs`](../supabase/scripts/generate_cards.cjs):
same three-stage pipeline, same prompts, same audits, same card shape — the CLI
writes `seed_data/*.json` for the global starter decks, this writes rows the
signed-in user owns.

| | CLI (`generate_cards.cjs`) | In-app builder |
| --- | --- | --- |
| Runs in | Node, on your machine | The browser tab |
| Key from | environment variables | the user, stored in their browser |
| Output | `supabase/seed_data/*.json` → `seed.sql` | `decks` + `cards` rows owned by the user |
| Providers | ollama, opencode, gemini | opencode, openai, anthropic, gemini |

## Screens

| Route | What it does |
| --- | --- |
| `/decks/new` | Describe → specification (form or YAML) → provider/key → launch |
| `/decks/runs/:jobId` | Live status, per-card results, activity log, save/download |
| Settings → **AI deck builder** | Manage provider keys outside a run |

A run keeps going while the learner navigates elsewhere in the app; the header
shows a live `Generating n/m` pill back to its status page.

## How a run works

```
spec ──▶ 1. blueprint     one prompt: 2–6 sections (skipped if the spec lists them)
     ──▶ 2. word sets     one prompt per section: {spanish, english} drafts, deduped
     ──▶ 3. cards         per card, until stable:
                            gap-fill  lexical → equivalents → examples → synonyms → cloze options
                            audits    example quality (per pair) + blind cloze solve (per sentence)
```

Stage 3 is `src/ai/enrich.js`, a port of
[`supabase/scripts/lib/enrich.cjs`](../supabase/scripts/lib/enrich.cjs): the
deterministic validator names which sub-prompt failed, so only that sub-prompt is
re-run, and each audit pass is fingerprinted into `card._audits` so a resumed run
never re-pays for work that already passed. Roughly **15 model calls and ~45s per
card** (measured on OpenCode Zen `gpt-5.6-luna`), divided by the parallelism the
user picks.

Cards finish in one of three states:

- **Ready** — every validator and audit passed.
- **Check** — complete and studiable, but a gate never went green within the
  repair budget. The open issues are listed on the card. Saved along with the rest.
- **Failed** — the provider errored on that card. Retryable from the run page.

## Where things live

| File | Role |
| --- | --- |
| `src/ai/providers.js` | Provider registry (endpoint, transport, models, CORS capability) |
| `src/ai/transport.js` | Request builder + response parser, shared by browser and relay |
| `src/ai/llmClient.js` | `chatJson()` with retries, JSON repair, timeouts, usage accounting |
| `src/ai/keyStore.js` | Keys in `localStorage` (device) or `sessionStorage` (this tab) |
| `src/ai/prompts.js` | Card prompts — a port of `scripts/lib/prompts.cjs`, text-identical |
| `src/ai/validate.js` | Deterministic validators — port of `scripts/lib/validate.cjs` |
| `src/ai/enrich.js` | Enrichment + audit loop — port of `scripts/lib/enrich.cjs` |
| `src/ai/generator.js` | The three stages, concurrency, progress/log events |
| `src/ai/deckSpec.js` | Spec schema, normalization, YAML ↔ spec, template |
| `src/ai/specPrompts.js` | "Draft my spec" / "improve my spec" assistant prompts |
| `src/ai/runManager.js` | Runs at module scope so navigation doesn't kill them |
| `src/ai/jobStore.js` | Run persistence (localStorage, newest 6) |
| `src/ai/saveDeck.js` | Deck + card inserts under the existing RLS policies |
| `api/_llmProxy.js` | The relay (see below); mounted by `vite.config.js` and `api/llm.js` |

**No migration is required.** `decks_insert_own` and `cards_insert_own`
(migration `0002`) already allow a user to create decks they own, and
`get_home_decks()` returns any deck with `user_id = auth.uid()`, so a generated
deck behaves exactly like a market deck the user added — smart practice,
minigames, FSRS scheduling included. Cards are written with
`generation_phase = 'refined'` (the app ignores `'draft'` cards) and carry
`examples` (0019) and `cloze_distractors_en` (0018), so the fill-in-the-blank
games work on them from the first review.

## Keys and the relay

Keys are stored **only in the user's browser** — never sent to Supabase, never
part of an export, never synced between devices. The storage scope is per
provider: `localStorage` so a run can be resumed tomorrow, or `sessionStorage`
for a shared computer.

Requests go straight from the page to the provider whenever the provider allows
it (OpenAI, Anthropic, Gemini), so the key travels only to the provider. OpenCode
Zen does not answer CORS preflights, so its calls are relayed by `POST /api/llm`:

- dev: Vite middleware (`llmProxyPlugin` in `vite.config.js`)
- production: the Vercel Node function `frontend/api/llm.js`

The relay holds no credentials of its own — the caller supplies the key per
request, it is used once and never logged or stored — and it only forwards to the
hosts in `ALLOWED_UPSTREAM_HOSTS`, so it cannot be used as a general proxy. Users
on a network that blocks a provider can opt into the relay for the other three
under **Advanced** in the provider panel.

## The specification

The same document the CLI's `--spec` files use, so specs move between the two.
The YAML tab downloads/uploads it as a `.yaml` file; the form edits the same
object.

```yaml
title: Pharmacy Basics
description: Practical English for buying medicine and describing simple symptoms.
topic: beginner English for pharmacy visits
difficulty: beginner            # beginner | elementary | intermediate | advanced
learner_profile: Spanish-speaking beginners who need practical English in a pharmacy
generation_notes: Keep vocabulary concrete, high-frequency, and immediately useful.
target_card_count: 20
language_from: es
language_to: en
sections: []                    # empty = the AI plans them
quality:
  example_audit: true           # judge every example: on-theme + blank inferable
  cloze_audit: true             # blind examiner: only the answer may fit the blank
  cloze_options: true           # curated wrong options for the word-bank game
  max_repairs: 2
```

Every field is copied into each downstream prompt as deck context, which is why
step 1 of the builder exists: the assistant turns one sentence into a filled-in
spec, and can revise an existing one against an instruction.

Turning the audits off makes a run roughly twice as cheap and noticeably worse:
they are what stop generic example sentences ("I like ____") and word-bank
options that are also correct.

## Failure modes worth knowing

- **Rate limits** surface per card; the client retries 429/5xx three times with
  backoff, then marks that card failed. "Retry failed cards" re-runs only those.
- **Closing the tab** ends the run — it is marked `interrupted` on the next load
  and resumes from the first unfinished card, keeping every audit that passed.
- **A model that ignores JSON mode** is handled by the client's JSON repair
  (fenced blocks, prose wrappers) and, for gateways that return the answer in
  `reasoning_content` with an empty `content` (OpenCode Zen + `glm-*`), by the
  parser's fallback in `transport.js`.
- **Quota exhaustion mid-run** looks like every remaining card failing with the
  provider's message; resume once the quota resets.
