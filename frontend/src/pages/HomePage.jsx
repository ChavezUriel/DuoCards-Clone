import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDeckPreview, fetchDueSummary, fetchHomeDecks, updateDeckSmartPracticeInclusion } from '../api';
import DeckCard from '../components/DeckCard';
import { maybeNotifyDueCards } from '../notifications';
import { loadPracticeSettings, savePracticeSettings } from '../practiceSettings';

const NEW_BLOCK_SIZE_RANGE = { min: 5, max: 12, step: 1 };
const REVIEW_BATCH_SIZE_RANGE = { min: 10, max: 50, step: 5 };

const INTERLEAVING_LEVELS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
];

function formatNextDue(nextDueAt) {
  if (!nextDueAt) {
    return null;
  }

  const dueDate = new Date(nextDueAt);
  if (Number.isNaN(dueDate.getTime())) {
    return null;
  }

  const hoursAway = (dueDate.getTime() - Date.now()) / 3_600_000;
  if (hoursAway <= 0) {
    return 'now';
  }
  if (hoursAway < 1) {
    return 'in less than an hour';
  }
  if (hoursAway < 24) {
    return `in ${Math.round(hoursAway)} h`;
  }
  return `in ${Math.round(hoursAway / 24)} d`;
}

function uniqueDeckIds(deckIds) {
  return [...new Set(deckIds)];
}

function sortDecksBySmartPractice(decks) {
  return [...decks].sort((leftDeck, rightDeck) => {
    if (leftDeck.is_enabled_in_smart_practice !== rightDeck.is_enabled_in_smart_practice) {
      return leftDeck.is_enabled_in_smart_practice ? -1 : 1;
    }
    if (leftDeck.completion_ratio !== rightDeck.completion_ratio) {
      return rightDeck.completion_ratio - leftDeck.completion_ratio;
    }
    return leftDeck.title.localeCompare(rightDeck.title);
  });
}

function normalizeSearchText(value) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreFieldMatch(fieldValue, query) {
  if (!fieldValue) return 0;
  const normalizedField = normalizeSearchText(fieldValue);
  if (!normalizedField) return 0;
  if (normalizedField === query) return 120;
  if (normalizedField.startsWith(query)) return 90;
  if (normalizedField.includes(query)) return 70;
  const queryTerms = query.split(' ');
  const matchedTerms = queryTerms.filter((term) => normalizedField.includes(term)).length;
  return matchedTerms === queryTerms.length ? 50 : matchedTerms > 0 ? 20 + matchedTerms : 0;
}

function buildDeckWordIndex(preview) {
  return preview.cards
    .flatMap((card) => [
      card.answer_en, card.prompt_es, card.section_name, card.definition_en,
      ...(card.main_translations_es || []), ...(card.collocations || []),
      ...(card.synonyms_en || []),
      card.example_sentence, card.example_en, card.example_es,
    ])
    .filter(Boolean)
    .join(' ');
}

function buildSearchMatchReasons(titleScore, descriptionScore, wordsScore) {
  const reasons = [];
  if (titleScore > 0) reasons.push('Title');
  if (descriptionScore > 0) reasons.push('Description');
  if (wordsScore > 0) reasons.push('Deck words');
  if (reasons.length === 0) return [];
  if (reasons.length === 1) return [`${reasons[0]} match`];
  if (reasons.length === 2) return [`${reasons[0]} & ${reasons[1]} match`];
  return [`${reasons.slice(0, -1).join(', ')} & ${reasons[reasons.length - 1]} match`];
}

function ModeStepper({ value, range, onStep, decrementLabel, incrementLabel }) {
  return (
    <div className="h-stepper">
      <button
        type="button"
        className="h-stepper__btn"
        onClick={() => onStep(-range.step)}
        disabled={value <= range.min}
        aria-label={decrementLabel}
      >
        −
      </button>
      <output className="h-stepper__value">{value}</output>
      <button
        type="button"
        className="h-stepper__btn"
        onClick={() => onStep(range.step)}
        disabled={value >= range.max}
        aria-label={incrementLabel}
      >
        +
      </button>
    </div>
  );
}

function rankDeckSearchResults(decks, query, deckWordIndexById) {
  if (!query) {
    return decks.map((deck) => ({ deck, searchScore: 0, searchDidMatch: false, searchMatchReasons: [] }));
  }
  return decks
    .map((deck, index) => {
      const titleScore = scoreFieldMatch(deck.title, query);
      const descriptionScore = scoreFieldMatch(deck.description, query);
      const wordsScore = scoreFieldMatch(deckWordIndexById[deck.id], query);
      const score = (titleScore * 1_000_000) + (descriptionScore * 1_000) + wordsScore;
      return {
        deck, index, score,
        searchScore: score,
        searchDidMatch: score > 0,
        searchMatchReasons: buildSearchMatchReasons(titleScore, descriptionScore, wordsScore),
      };
    })
    .sort((l, r) => {
      if (l.searchDidMatch !== r.searchDidMatch) return l.searchDidMatch ? -1 : 1;
      if (l.searchScore !== r.searchScore) return r.searchScore - l.searchScore;
      return l.index - r.index;
    });
}

function HomePage() {
  const [decks, setDecks] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(() => loadPracticeSettings());
  const [pendingDeckIds, setPendingDeckIds] = useState([]);
  const [actionError, setActionError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [deckWordIndexById, setDeckWordIndexById] = useState({});
  const [dueSummary, setDueSummary] = useState(null);

  const areAllDecksEnabledInSmartPractice = decks.length > 0 && decks.every((d) => d.is_enabled_in_smart_practice);
  const enabledDeckCount = decks.filter((d) => d.is_enabled_in_smart_practice).length;
  const hasPendingDeckUpdates = pendingDeckIds.length > 0;

  function updateSettings(partialSettings) {
    setSettings((current) => {
      const nextSettings = { ...current, ...partialSettings };
      savePracticeSettings(nextSettings);
      return nextSettings;
    });
  }

  function stepSetting(key, delta, range) {
    setSettings((current) => {
      const nextValue = Math.min(range.max, Math.max(range.min, current[key] + delta));
      if (nextValue === current[key]) {
        return current;
      }
      const nextSettings = { ...current, [key]: nextValue };
      savePracticeSettings(nextSettings);
      return nextSettings;
    });
  }

  useEffect(() => {
    let cancelled = false;
    async function loadDecks() {
      try {
        const nextDecks = await fetchHomeDecks();
        if (!cancelled) { setDecks(sortDecksBySmartPractice(nextDecks)); setStatus('ready'); }
      } catch (loadError) {
        if (!cancelled) { setError(loadError.message); setStatus('error'); }
      }
    }
    loadDecks();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadDueSummary() {
      try {
        const summary = await fetchDueSummary();
        if (!cancelled) {
          setDueSummary(summary);
          maybeNotifyDueCards(summary);
        }
      } catch {
        // The due strip is progressive enhancement; the page works without it.
      }
    }
    loadDueSummary();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadDeckWordIndexes() {
      if (decks.length === 0) return;
      const results = await Promise.allSettled(
        decks.map(async (deck) => {
          const preview = await fetchDeckPreview(deck.id);
          return [deck.id, buildDeckWordIndex(preview)];
        })
      );
      if (cancelled) return;
      const nextIndex = {};
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const [deckId, wordIndex] = result.value;
          nextIndex[deckId] = wordIndex;
        }
      }
      setDeckWordIndexById(nextIndex);
    }
    loadDeckWordIndexes();
    return () => { cancelled = true; };
  }, [decks]);

  const normalizedSearchQuery = normalizeSearchText(searchQuery);
  const visibleDeckEntries = useMemo(
    () => rankDeckSearchResults(decks, normalizedSearchQuery, deckWordIndexById),
    [deckWordIndexById, decks, normalizedSearchQuery]
  );

  async function updateSmartPracticeInclusion(deckIds, isEnabled) {
    if (deckIds.length === 0) return;
    setActionError('');
    setPendingDeckIds((current) => uniqueDeckIds([...current, ...deckIds]));
    try {
      const results = await Promise.allSettled(
        deckIds.map((id) => updateDeckSmartPracticeInclusion(id, isEnabled))
      );
      const successIds = deckIds.filter((_, i) => results[i].status === 'fulfilled');
      const failedResults = results.filter((r) => r.status === 'rejected');
      if (successIds.length > 0) {
        setDecks((current) => current.map((deck) =>
          successIds.includes(deck.id) ? { ...deck, is_enabled_in_smart_practice: isEnabled } : deck
        ));
      }
      if (failedResults.length > 0) {
        const firstError = failedResults[0].reason;
        setActionError(
          failedResults.length === deckIds.length
            ? firstError.message
            : 'Some decks could not be updated. Please try again.'
        );
      }
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setPendingDeckIds((current) => current.filter((id) => !deckIds.includes(id)));
    }
  }

  async function handleToggleSmartPractice(deckId, isEnabled) {
    await updateSmartPracticeInclusion([deckId], isEnabled);
  }

  async function handleToggleAllDecks() {
    const nextState = !areAllDecksEnabledInSmartPractice;
    const targetIds = decks
      .filter((d) => d.is_enabled_in_smart_practice !== nextState)
      .map((d) => d.id);
    await updateSmartPracticeInclusion(targetIds, nextState);
  }

  if (status === 'loading') {
    return <p className="h-empty-state">Loading your home decks…</p>;
  }

  if (status === 'error') {
    return <p className="h-empty-state h-empty-state--error">Unable to load decks: {error}</p>;
  }

  if (decks.length === 0) {
    return (
      <div className="h-empty-panel panel">
        <h2>No decks on home</h2>
        <p>Open the deck market and add decks to bring them back here.</p>
        <Link className="button button--primary" to="/market">Open market</Link>
      </div>
    );
  }

  const sessionCards = settings.new_block_size + settings.review_batch_size;
  const dueNow = dueSummary?.due_now ?? 0;
  const nextDueLabel = dueNow === 0 && dueSummary?.next_due_at ? formatNextDue(dueSummary.next_due_at) : null;

  return (
    <>
      {/* ── Practice modes ────────────────────────────────────────── */}
      <div className="h-mode-grid">
        <article className="h-mode-card h-mode-card--primary">
          <Link
            className="h-mode-card__link"
            to="/practice"
            onClick={() => updateSettings({ focus_mode: 'auto' })}
          >
            <div className="h-mode-card__top">
              <span className="h-action-kicker">RECOMMENDED</span>
              <span className="h-action-arrow">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">Play Auto</div>
              <div className="h-mode-card__meta">
                {sessionCards} cards · ~{Math.ceil(sessionCards / 2)} min · new + review
              </div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <span className="h-mode-card__setting-label">Interleaving</span>
            <div className="h-seg" role="group" aria-label="Interleaving intensity">
              {INTERLEAVING_LEVELS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`h-seg__btn${settings.interleaving_intensity === value ? ' h-seg__btn--active' : ''}`}
                  aria-pressed={settings.interleaving_intensity === value}
                  onClick={() => updateSettings({ interleaving_intensity: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </article>

        <article className="h-mode-card">
          <Link
            className="h-mode-card__link"
            to="/practice"
            onClick={() => updateSettings({ focus_mode: 'new_material' })}
          >
            <div className="h-mode-card__top">
              <span className="h-action-kicker h-action-kicker--muted">SESSION</span>
              <span className="h-action-arrow h-action-arrow--muted">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">New material</div>
              <div className="h-mode-card__meta">Fresh cards you haven't met yet.</div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <span className="h-mode-card__setting-label">Cards per session</span>
            <ModeStepper
              value={settings.new_block_size}
              range={NEW_BLOCK_SIZE_RANGE}
              onStep={(delta) => stepSetting('new_block_size', delta, NEW_BLOCK_SIZE_RANGE)}
              decrementLabel="Fewer new cards per session"
              incrementLabel="More new cards per session"
            />
          </div>
        </article>

        <article className={`h-mode-card${dueNow > 0 ? ' h-mode-card--due' : ''}`}>
          <Link
            className="h-mode-card__link"
            to="/practice"
            onClick={() => updateSettings({ focus_mode: 'review' })}
          >
            <div className="h-mode-card__top">
              <span className="h-action-kicker h-action-kicker--muted">SESSION</span>
              <span className="h-action-arrow h-action-arrow--muted">→</span>
            </div>
            <div>
              <div className="h-mode-card__title">Review</div>
              <div className="h-mode-card__meta">
                {dueNow > 0
                  ? `${dueNow} card${dueNow === 1 ? '' : 's'} due now`
                  : nextDueLabel
                    ? `Nothing due · next ${nextDueLabel}`
                    : 'Settle the cards due back today.'}
              </div>
            </div>
          </Link>
          <div className="h-mode-card__setting">
            <span className="h-mode-card__setting-label">Cards per session</span>
            <ModeStepper
              value={settings.review_batch_size}
              range={REVIEW_BATCH_SIZE_RANGE}
              onStep={(delta) => stepSetting('review_batch_size', delta, REVIEW_BATCH_SIZE_RANGE)}
              decrementLabel="Fewer review cards per session"
              incrementLabel="More review cards per session"
            />
          </div>
        </article>
      </div>

      {/* ── Home decks ────────────────────────────────────────────── */}
      <section className="h-decks">
        <div className="h-decks__header">
          <div className="h-decks__header-left">
            <h2 className="h-decks__title">Home decks</h2>
            <div className="h-decks__meta">
              <span>{enabledDeckCount} of {decks.length} in rotation</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="h-decks__text-action"
                onClick={handleToggleAllDecks}
                disabled={hasPendingDeckUpdates || decks.length === 0}
              >
                {areAllDecksEnabledInSmartPractice ? 'Pause all' : 'Enable all'}
              </button>
              <span aria-hidden="true">·</span>
              <Link to="/market" className="h-decks__text-action">Open market</Link>
            </div>
          </div>

          <label className="h-deck-search" aria-label="Search home decks">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)' }}>
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search home decks"
            />
          </label>
        </div>

        {actionError ? <p className="deck-grid__status deck-grid__status--error">{actionError}</p> : null}

        <div className="h-deck-grid">
          {visibleDeckEntries.map(({ deck, searchDidMatch, searchMatchReasons }) => (
            <DeckCard
              key={deck.id}
              deck={deck}
              isPending={pendingDeckIds.includes(deck.id)}
              variant="home"
              onToggleSmartPractice={handleToggleSmartPractice}
              isSearchDimmed={Boolean(normalizedSearchQuery) && !searchDidMatch}
              searchMatchReasons={searchMatchReasons}
            />
          ))}
        </div>
      </section>
    </>
  );
}

export default HomePage;
