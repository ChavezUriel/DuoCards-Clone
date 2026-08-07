// The generation run: spec in, finished cards out.
//
// Three stages, mirroring supabase/scripts/generate_cards.cjs:
//   1. blueprint — plan the deck's sections (skipped when the spec lists them)
//   2. word sets — draft {spanish, english} pairs per section, deduped globally
//   3. cards     — enrich + audit each draft (enrich.js), N cards in parallel
//
// The run lives in the browser tab that started it. Everything it learns is
// written back into the job object after every card, and the job is persisted
// by the caller, so closing the tab loses at most one card of work and the run
// can be resumed: cards already marked `ready` are skipped, and partially
// enriched cards keep their fields and audit passes.

import { blueprintPrompt, wordSetPrompt } from './prompts';
import { processCard, cardStatus } from './enrich';
import { normCard, pairKey, optText } from './cards';
import { flatten } from './validate';
import { plannedCardCount } from './deckSpec';

export const CARD_STATUS = {
  pending: 'pending',
  working: 'working',
  ready: 'ready',
  flagged: 'flagged', // usable, but one or more quality gates never passed
  failed: 'failed',
};

let logSeq = 0;

export function makeLogEntry(level, message) {
  logSeq += 1;
  return { id: `${Date.now()}-${logSeq}`, at: new Date().toISOString(), level, message };
}

// A fresh job record for `spec`, ready to be persisted and run.
export function createJob({ spec, provider, concurrency = 3 }) {
  const now = new Date().toISOString();
  return {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    status: 'pending',
    stage: 'blueprint',
    spec,
    provider,
    concurrency,
    sections: [],
    cards: [],
    log: [makeLogEntry('info', `Run created for “${spec.title}” — ${plannedCardCount(spec)} cards planned.`)],
    usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
    error: null,
    savedDeck: null,
  };
}

export function jobProgress(job) {
  const cards = job.cards ?? [];
  const done = cards.filter((card) => card._status === CARD_STATUS.ready || card._status === CARD_STATUS.flagged).length;
  const failed = cards.filter((card) => card._status === CARD_STATUS.failed).length;
  const working = cards.filter((card) => card._status === CARD_STATUS.working).length;
  const total = cards.length || plannedCardCount(job.spec);
  return {
    total,
    done,
    failed,
    working,
    ready: cards.filter((card) => card._status === CARD_STATUS.ready).length,
    flagged: cards.filter((card) => card._status === CARD_STATUS.flagged).length,
    ratio: total > 0 ? Math.min(1, (done + failed) / total) : 0,
  };
}

// Cards worth writing to a deck: everything that finished, flagged included
// (a flagged card is complete and studiable — one quality gate just never went
// green, and the UI says which).
export function usableCards(job) {
  return (job.cards ?? [])
    .filter((card) => card._status === CARD_STATUS.ready || card._status === CARD_STATUS.flagged)
    .map(({ _status, _issues, _ms, _log, ...card }) => card);
}

function sectionsFromSpec(spec) {
  return spec.sections.map((section) => ({
    name: section.name,
    communicative_goal: section.communicative_goal,
    lexical_focus: section.lexical_focus,
    target_card_count: section.target_card_count,
  }));
}

function normalizeBlueprint(response, spec) {
  const sections = (Array.isArray(response?.sections) ? response.sections : [])
    .map((section) => ({
      name: optText(section?.name),
      communicative_goal: optText(section?.communicative_goal) ?? '',
      lexical_focus: Array.isArray(section?.lexical_focus)
        ? section.lexical_focus.map((item) => optText(item)).filter(Boolean)
        : [],
      target_card_count: Math.max(1, Math.round(Number(section?.target_card_count) || 0)),
    }))
    .filter((section) => section.name);
  if (!sections.length) {
    // A model that returns nothing usable must not sink the run: one section
    // covering the whole deck still generates a coherent word set.
    return [{
      name: spec.title,
      communicative_goal: spec.topic,
      lexical_focus: [],
      target_card_count: spec.target_card_count,
    }];
  }
  return sections;
}

// Run `worker` over `items` with at most `limit` in flight.
async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items.entries()];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [index, item] = next;
      await worker(item, index);
    }
  });
  await Promise.all(runners);
}

// Execute (or resume) `job` in place.
//
//   client   an llmClient (chatJson)
//   onUpdate called after every meaningful change with the job — the UI renders
//            from it and the caller persists it
//   signal   AbortSignal; a cancel or pause request aborts between prompts
//
// Returns the job. Never throws for a cancel: the job's status carries the
// outcome ('completed' | 'cancelled' | 'failed').
export async function runJob(job, { client, onUpdate = () => {}, signal }) {
  const touch = (mutate) => {
    mutate();
    job.updatedAt = new Date().toISOString();
    onUpdate(job);
  };
  const log = (level, message) => touch(() => {
    job.log.push(makeLogEntry(level, message));
    // The log is persisted with the job; keep it bounded.
    if (job.log.length > 400) job.log = job.log.slice(-400);
  });

  const runPrompt = async (prompt) => client.chatJson({ ...prompt, signal });

  touch(() => {
    job.status = 'running';
    job.error = null;
    job.startedAt = job.startedAt ?? new Date().toISOString();
  });

  try {
    // --- stage 1: blueprint ------------------------------------------------
    if (!job.sections.length) {
      if (job.spec.sections.length) {
        touch(() => { job.stage = 'blueprint'; job.sections = sectionsFromSpec(job.spec); });
        log('info', `Using the ${job.sections.length} section(s) from the spec.`);
      } else {
        touch(() => { job.stage = 'blueprint'; });
        log('info', 'Planning the deck sections…');
        const response = await runPrompt(blueprintPrompt(job.spec));
        touch(() => { job.sections = normalizeBlueprint(response, job.spec); });
        log('success', `Blueprint ready: ${job.sections.map((section) => section.name).join(', ')}.`);
      }
    }

    // --- stage 2: word sets ------------------------------------------------
    if (!job.cards.length) {
      touch(() => { job.stage = 'wordsets'; });
      const seen = new Set();
      const drafts = [];
      for (const section of job.sections) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        log('info', `Drafting words for “${section.name}” (${section.target_card_count} cards)…`);
        // Earlier sections' pairs go into must_avoid_pairs so the model doesn't
        // rediscover the same words section after section.
        const avoid = drafts.map((draft) => ({ spanish: draft.spanish_text, english: draft.english_text }));
        const response = await runPrompt(
          wordSetPrompt(job.spec, section, section.target_card_count, avoid),
        );
        const rows = Array.isArray(response?.cards) ? response.cards : [];
        let kept = 0;
        for (const row of rows) {
          const card = normCard({ ...row, section_name: section.name }, job.spec.title);
          if (!card) continue;
          const key = pairKey(card.spanish_text, card.english_text);
          if (seen.has(key)) continue;
          seen.add(key);
          drafts.push({ ...card, _status: CARD_STATUS.pending, _issues: [], _ms: 0 });
          kept += 1;
          if (kept >= section.target_card_count) break;
        }
        touch(() => { job.cards = drafts.slice(); });
        log(
          kept > 0 ? 'success' : 'warn',
          `“${section.name}”: ${kept} card(s) drafted${rows.length > kept ? ` (${rows.length - kept} duplicate/invalid dropped)` : ''}.`,
        );
      }
      if (!job.cards.length) {
        throw new Error('The model returned no usable word pairs. Try a different model or a more concrete topic.');
      }
    }

    // --- stage 3: enrich + audit ------------------------------------------
    touch(() => { job.stage = 'cards'; });
    const pending = job.cards.filter((card) => card._status !== CARD_STATUS.ready && card._status !== CARD_STATUS.flagged);
    if (pending.length) {
      log('info', `Enriching ${pending.length} card(s) with ${job.concurrency} in parallel…`);
    }

    await mapWithConcurrency(pending, job.concurrency, async (card) => {
      if (signal?.aborted) return;
      const startedAt = Date.now();
      touch(() => { card._status = CARD_STATUS.working; card._issues = []; });
      try {
        const { card: enriched, issues } = await processCard(card, {
          deck: job.spec,
          maxRepairs: job.spec.quality.max_repairs,
          runPrompt,
          auditExamples: job.spec.quality.example_audit,
          auditCloze: job.spec.quality.cloze_audit,
          wantCloze: job.spec.quality.cloze_options,
          log: (message) => log('info', `${card.english_text}: ${message}`),
          signal,
        });
        const problems = flatten(issues);
        touch(() => {
          Object.assign(card, enriched);
          card._ms = Date.now() - startedAt;
          card._issues = problems;
          card._status = problems.length ? CARD_STATUS.flagged : CARD_STATUS.ready;
        });
        if (problems.length) {
          log('warn', `${card.english_text}: kept with ${problems.length} open issue(s) — ${problems[0]}`);
        }
      } catch (cardError) {
        if (cardError?.name === 'AbortError') {
          touch(() => { card._status = CARD_STATUS.pending; });
          return;
        }
        touch(() => {
          card._status = CARD_STATUS.failed;
          card._issues = [cardError.message];
          card._ms = Date.now() - startedAt;
        });
        log('error', `${card.english_text}: ${cardError.message}`);
      }
    });

    if (signal?.aborted) {
      touch(() => { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); });
      log('warn', 'Run stopped.');
      return job;
    }

    const progress = jobProgress(job);
    touch(() => {
      job.stage = 'done';
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
    });
    log(
      progress.failed ? 'warn' : 'success',
      `Finished: ${progress.ready} ready, ${progress.flagged} with open issues, ${progress.failed} failed.`,
    );
    return job;
  } catch (runError) {
    if (runError?.name === 'AbortError') {
      touch(() => { job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); });
      log('warn', 'Run stopped.');
      return job;
    }
    touch(() => {
      job.status = 'failed';
      job.error = runError.message;
      job.finishedAt = new Date().toISOString();
    });
    log('error', runError.message);
    return job;
  }
}

// Re-check a finished job's cards without calling the model — used after the
// user edits a card by hand on the results screen.
export function revalidateJob(job) {
  for (const card of job.cards ?? []) {
    if (card._status === CARD_STATUS.failed || card._status === CARD_STATUS.pending) continue;
    const problems = flatten(cardStatus(card, job.spec, {
      auditExamples: job.spec.quality.example_audit,
      auditCloze: job.spec.quality.cloze_audit,
      wantCloze: job.spec.quality.cloze_options,
    }));
    card._issues = problems;
    card._status = problems.length ? CARD_STATUS.flagged : CARD_STATUS.ready;
  }
  return job;
}
