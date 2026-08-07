// Owns the generation runs that are actually in flight.
//
// A run must not stop because the user navigated to Home to check a deck, so it
// cannot live inside a React component. It lives here, at module scope: pages
// subscribe for updates and can leave at any time. The API key stays in this
// module's memory for the duration of the run and is never persisted by it.
//
// Persistence is throttled (one write per second, plus an immediate write on
// every status change) so a 100-card run doesn't hammer localStorage.

import { createLlmClient } from './llmClient';
import { runJob } from './generator';
import { saveJob } from './jobStore';

const runs = new Map(); // jobId -> { job, controller, saveTimer, lastStatus }
const subscribers = new Map(); // jobId -> Set<callback>
const globalSubscribers = new Set();

function notify(jobId, job) {
  for (const callback of subscribers.get(jobId) ?? []) callback(job);
  for (const callback of globalSubscribers) callback();
}

function persist(entry, { immediate = false } = {}) {
  const statusChanged = entry.lastStatus !== entry.job.status;
  entry.lastStatus = entry.job.status;
  if (immediate || statusChanged) {
    clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
    saveJob(entry.job);
    return;
  }
  if (entry.saveTimer) return;
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    saveJob(entry.job);
  }, 1000);
}

// A run in flight is work the user paid for; warn before the tab takes it down.
function updateUnloadGuard() {
  if (typeof window === 'undefined') return;
  const active = runs.size > 0;
  if (active && !updateUnloadGuard.attached) {
    updateUnloadGuard.handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', updateUnloadGuard.handler);
    updateUnloadGuard.attached = true;
  } else if (!active && updateUnloadGuard.attached) {
    window.removeEventListener('beforeunload', updateUnloadGuard.handler);
    updateUnloadGuard.attached = false;
  }
}

export function isRunning(jobId) {
  return runs.has(jobId);
}

export function runningJobIds() {
  return [...runs.keys()];
}

// Subscribe to one job's updates. Returns an unsubscribe function.
export function subscribeToJob(jobId, callback) {
  if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
  subscribers.get(jobId).add(callback);
  return () => {
    subscribers.get(jobId)?.delete(callback);
    if (subscribers.get(jobId)?.size === 0) subscribers.delete(jobId);
  };
}

// Subscribe to "something started or stopped" — for the header indicator.
export function subscribeToRuns(callback) {
  globalSubscribers.add(callback);
  return () => globalSubscribers.delete(callback);
}

// Start (or resume) `job` with `credential` ({ providerId, model, apiKey, … }).
// Returns the promise of the finished job; callers usually ignore it and
// subscribe instead.
export function startRun(job, credential) {
  if (runs.has(job.id)) return runs.get(job.id).promise;

  const controller = new AbortController();
  const entry = { job, controller, saveTimer: null, lastStatus: job.status };
  runs.set(job.id, entry);
  updateUnloadGuard();

  const client = createLlmClient(credential, {
    onUsage: (usage) => {
      job.usage.calls += usage.calls;
      job.usage.input_tokens += usage.input_tokens;
      job.usage.output_tokens += usage.output_tokens;
    },
  });
  job.provider = { ...client.describe() };

  const promise = runJob(job, {
    client,
    signal: controller.signal,
    onUpdate: (current) => {
      persist(entry);
      notify(job.id, current);
    },
  })
    .finally(() => {
      runs.delete(job.id);
      persist(entry, { immediate: true });
      updateUnloadGuard();
      notify(job.id, job);
    });

  entry.promise = promise;
  return promise;
}

// Ask a run to stop. It ends at the next prompt boundary, keeping every card
// finished so far; the job's status becomes 'cancelled' and it can be resumed.
export function stopRun(jobId) {
  runs.get(jobId)?.controller.abort();
}

// The live job object for an in-flight run (the store's copy may lag by up to a
// second).
export function getLiveJob(jobId) {
  return runs.get(jobId)?.job ?? null;
}
