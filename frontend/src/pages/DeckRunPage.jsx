import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CARD_STATUS, jobProgress, usableCards } from '../ai/generator';
import { deleteJob, getJob, saveJob } from '../ai/jobStore';
import { getLiveJob, isRunning, startRun, stopRun, subscribeToJob } from '../ai/runManager';
import { loadCredential } from '../ai/keyStore';
import { getProvider } from '../ai/providers';
import { saveJobAsDeck } from '../ai/saveDeck';
import GeneratedCardList from '../components/GeneratedCardList';

const STAGES = [
  ['blueprint', 'Blueprint'],
  ['wordsets', 'Word sets'],
  ['cards', 'Cards'],
  ['done', 'Done'],
];

const STATUS_COPY = {
  pending: 'Not started',
  running: 'Generating',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  failed: 'Failed',
  completed: 'Finished',
};

function formatDuration(fromIso, toIso) {
  if (!fromIso) return '—';
  const seconds = Math.max(0, Math.round(((toIso ? new Date(toIso) : new Date()).getTime() - new Date(fromIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function DeckRunPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [, bump] = useReducer((count) => count + 1, 0);
  const [job, setJob] = useState(() => getLiveJob(jobId) ?? getJob(jobId));
  const [saveState, setSaveState] = useState({ status: 'idle', message: '' });
  const [deckTitle, setDeckTitle] = useState(job?.spec.title ?? '');
  const [showLog, setShowLog] = useState(true);
  const logBoxRef = useRef(null);

  const live = isRunning(jobId);

  // The runner mutates the job object in place (so a page that mounts mid-run
  // sees everything already produced); re-render on its updates.
  useEffect(() => subscribeToJob(jobId, (next) => { setJob(next); bump(); }), [jobId]);

  // While a run is in flight, keep the elapsed clock honest.
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(bump, 1000);
    return () => clearInterval(timer);
  }, [live]);

  // Keep the log pinned to its newest line — by scrolling the log box itself,
  // never scrollIntoView, which would drag the whole page down to it on mount.
  useEffect(() => {
    const box = logBoxRef.current;
    if (box && showLog && live) box.scrollTop = box.scrollHeight;
  }, [showLog, live, job?.log.length]);

  const progress = useMemo(() => (job ? jobProgress(job) : null), [job, job?.updatedAt]);

  if (!job) {
    return (
      <div className="ai-page">
        <p className="h-empty-state">This run is no longer on this device.</p>
        <div className="st-actions">
          <Link className="button button--primary" to="/decks/new">Start a new one</Link>
        </div>
      </div>
    );
  }

  const provider = getProvider(job.provider?.providerId);
  const finished = ['completed', 'cancelled', 'failed', 'interrupted'].includes(job.status);
  // Cards that never got their turn (a stop, a closed tab) are what "resume"
  // is for; cards the provider errored on get their own retry button, so a run
  // whose only gap is failures doesn't offer two buttons that do the same thing.
  const resumable = finished && (
    job.stage !== 'done' ||
    job.cards.some((card) => card._status === CARD_STATUS.pending || card._status === CARD_STATUS.working)
  );
  const savable = usableCards(job).length;

  function handleResume() {
    const credential = loadCredential(job.provider?.providerId ?? 'opencode');
    if (!credential.apiKey) {
      setSaveState({ status: 'error', message: `Add your ${provider.label} key in the builder before resuming.` });
      return;
    }
    startRun(job, { ...credential, model: job.provider?.model || credential.model });
    bump();
  }

  function handleRetryFailed() {
    for (const card of job.cards) {
      if (card._status === CARD_STATUS.failed) {
        card._status = CARD_STATUS.pending;
        card._issues = [];
      }
    }
    saveJob(job);
    handleResume();
  }

  async function handleSave() {
    setSaveState({ status: 'working', message: '' });
    try {
      const { deck, cardCount } = await saveJobAsDeck(job, {
        title: deckTitle,
        description: job.spec.description,
        existingDeckId: job.savedDeck?.id ?? null,
      });
      job.savedDeck = { id: deck.id, slug: deck.slug, title: deck.title, cardCount };
      saveJob(job);
      setSaveState({ status: 'done', message: `Saved ${cardCount} cards to “${deck.title}”.` });
      bump();
    } catch (error) {
      if (error.partial) {
        job.savedDeck = { id: error.partial.deck.id, slug: error.partial.deck.slug, title: error.partial.deck.title, cardCount: error.partial.cardCount };
        saveJob(job);
      }
      setSaveState({ status: 'error', message: error.message });
    }
  }

  function handleDownload() {
    const payload = {
      slug: job.savedDeck?.slug ?? null,
      title: job.spec.title,
      description: job.spec.description,
      language_from: job.spec.language_from,
      language_to: job.spec.language_to,
      cards: usableCards(job),
    };
    const blob = new Blob([JSON.stringify([payload], null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(job.spec.title || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.seed.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function handleDelete() {
    if (live) stopRun(jobId);
    deleteJob(jobId);
    navigate('/decks/new');
  }

  const stageIndex = STAGES.findIndex(([id]) => id === job.stage);

  return (
    <div className="ai-page">
      <header className="ai-run__header">
        <div>
          <p className="st-kicker">RUN · {job.id.slice(4, 12)}</p>
          <h1 className="st-header__title">{job.spec.title || 'Untitled deck'}</h1>
          <p className="st-section__hint">
            {provider.label} · {job.provider?.model} · started {job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : '—'} ·{' '}
            {formatDuration(job.startedAt, job.finishedAt)} elapsed
          </p>
        </div>
        <span className={`ai-status ai-status--${job.status} ai-status--large`}>
          {STATUS_COPY[job.status] ?? job.status}
        </span>
      </header>

      <section className="panel st-section" aria-label="Progress">
        <ol className="ai-stages">
          {STAGES.map(([id, label], index) => (
            <li
              key={id}
              className={`ai-stage${index < stageIndex ? ' ai-stage--done' : ''}${index === stageIndex ? ' ai-stage--active' : ''}`}
            >
              <span className="ai-stage__dot" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>

        <div className="ai-progress">
          <div className="ai-progress__bar">
            <span className="ai-progress__fill" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
          </div>
          <div className="ai-progress__counts">
            <span><strong>{progress.done}</strong> of {progress.total} cards</span>
            {progress.working > 0 ? <span>{progress.working} in flight</span> : null}
            {progress.flagged > 0 ? <span className="ai-count--warn">{progress.flagged} with open issues</span> : null}
            {progress.failed > 0 ? <span className="ai-count--error">{progress.failed} failed</span> : null}
            <span className="ai-count--muted">
              {job.usage.calls} calls · {(job.usage.input_tokens + job.usage.output_tokens).toLocaleString()} tokens
            </span>
          </div>
        </div>

        {job.error ? <p className="st-error">{job.error}</p> : null}

        <div className="st-actions">
          {live ? (
            <button type="button" className="button button--secondary" onClick={() => stopRun(jobId)}>
              Stop after the current card
            </button>
          ) : null}
          {!live && resumable ? (
            <button type="button" className="button button--primary" onClick={handleResume}>
              Resume run
            </button>
          ) : null}
          {!live && progress.failed > 0 ? (
            <button type="button" className="button button--secondary" onClick={handleRetryFailed}>
              Retry {progress.failed} failed card{progress.failed === 1 ? '' : 's'}
            </button>
          ) : null}
          {!live ? (
            <button type="button" className="button button--secondary st-button--compact" onClick={handleDelete}>
              Delete run
            </button>
          ) : null}
        </div>
      </section>

      {savable > 0 ? (
        <section className="panel st-section" aria-labelledby="ai-save-title">
          <div>
            <h2 className="st-section__title" id="ai-save-title">
              {job.savedDeck ? 'Saved to your decks' : 'Save to your decks'}
            </h2>
            <p className="st-section__hint">
              {job.savedDeck
                ? `“${job.savedDeck.title}” is on your home screen with ${job.savedDeck.cardCount} cards, ready for smart practice.`
                : `${savable} finished card${savable === 1 ? '' : 's'} will become a personal deck — reviews, minigames and scheduling included.`}
            </p>
          </div>
          {!job.savedDeck ? (
            <label className="st-field">
              <span className="st-field__label">Deck name</span>
              <input
                className="st-input"
                value={deckTitle}
                onChange={(event) => setDeckTitle(event.target.value)}
                placeholder="Deck name"
              />
            </label>
          ) : null}
          <div className="st-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={handleSave}
              disabled={saveState.status === 'working' || !deckTitle.trim()}
            >
              {saveState.status === 'working'
                ? 'Saving…'
                : job.savedDeck ? 'Save new cards again' : 'Save deck'}
            </button>
            {job.savedDeck ? (
              <>
                <Link className="button button--secondary" to={`/decks/${job.savedDeck.id}/words`}>Open the deck</Link>
                <Link className="button button--secondary" to="/">Go to home</Link>
              </>
            ) : null}
            <button type="button" className="button button--secondary st-button--compact" onClick={handleDownload}>
              Download JSON
            </button>
          </div>
          {saveState.status === 'done' ? <p className="st-success">{saveState.message}</p> : null}
          {saveState.status === 'error' ? <p className="st-error">{saveState.message}</p> : null}
        </section>
      ) : null}

      <GeneratedCardList job={job} />

      <section className="panel st-section" aria-labelledby="ai-log-title">
        <div className="ai-run__log-head">
          <h2 className="st-section__title" id="ai-log-title">Activity</h2>
          <button type="button" className="ai-link" onClick={() => setShowLog((current) => !current)}>
            {showLog ? 'Hide' : 'Show'}
          </button>
        </div>
        {showLog ? (
          <ol className="ai-log" ref={logBoxRef}>
            {job.log.map((entry) => (
              <li key={entry.id} className={`ai-log__row ai-log__row--${entry.level}`}>
                <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </div>
  );
}

export default DeckRunPage;
