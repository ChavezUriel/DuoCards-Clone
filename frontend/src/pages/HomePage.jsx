import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDeckPreview, fetchDueSummary, fetchHomeDecks, updateDeckSmartPracticeInclusion } from '../api';
import DeckCard from '../components/DeckCard';
import {
  isNotificationSupported,
  loadReminderSettings,
  maybeNotifyDueCards,
  requestNotificationPermission,
  saveReminderSettings,
} from '../notifications';
import { loadPracticeSettings, savePracticeSettings } from '../practiceSettings';

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
  const [isPracticeSettingsOpen, setIsPracticeSettingsOpen] = useState(false);
  const [shouldRenderPracticeSettings, setShouldRenderPracticeSettings] = useState(false);
  const [pendingDeckIds, setPendingDeckIds] = useState([]);
  const [actionError, setActionError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [deckWordIndexById, setDeckWordIndexById] = useState({});
  const [dueSummary, setDueSummary] = useState(null);
  const [reminderSettings, setReminderSettings] = useState(() => loadReminderSettings());
  const deckReviewSectionRef = useRef(null);

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

  function handleTogglePracticeSettings() {
    setIsPracticeSettingsOpen((current) => !current);
  }

  function handleScrollToDeckReview() {
    deckReviewSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  useEffect(() => {
    if (isPracticeSettingsOpen) {
      setShouldRenderPracticeSettings(true);
      return undefined;
    }
    const timeoutId = window.setTimeout(() => setShouldRenderPracticeSettings(false), 220);
    return () => window.clearTimeout(timeoutId);
  }, [isPracticeSettingsOpen]);

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

  async function handleToggleReminder() {
    if (reminderSettings.enabled) {
      const nextSettings = { ...reminderSettings, enabled: false };
      setReminderSettings(nextSettings);
      saveReminderSettings(nextSettings);
      return;
    }

    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      return;
    }

    const nextSettings = { ...reminderSettings, enabled: true };
    setReminderSettings(nextSettings);
    saveReminderSettings(nextSettings);
    if (dueSummary) {
      maybeNotifyDueCards(dueSummary);
    }
  }

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

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <div className="h-hero">
        <p className="h-hero__kicker">SMART PRACTICE</p>
        <div className="h-hero__layout">
          <div className="h-hero__intro">
            <h1 className="h-hero__headline">A calm space to remember every word.</h1>
            <p className="h-hero__copy">
              Surface the right cards at the right moment — each session stays focused and worth showing up for.
            </p>
            {isNotificationSupported() ? (
              <button
                type="button"
                className={`h-reminder-toggle${reminderSettings.enabled ? ' h-reminder-toggle--on' : ''}`}
                onClick={handleToggleReminder}
                aria-pressed={reminderSettings.enabled}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path
                    d="M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 3.6-1 5-1.9 6h14.8c-.9-1-1.9-2.4-1.9-6A5.5 5.5 0 0 0 12 3.5Z"
                    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                  />
                  <path d="M10 18.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
                <span>{reminderSettings.enabled ? 'Daily reminder on' : 'Remind me when cards are due'}</span>
              </button>
            ) : null}
          </div>
          <div className="h-glance-grid">
            <Link
              className={`h-glance-card h-glance-card--link${(dueSummary?.due_now ?? 0) > 0 ? ' h-glance-card--due' : ''}`}
              to="/practice"
              onClick={() => updateSettings({ focus_mode: 'review' })}
            >
              <div className="h-glance-card__value">{dueSummary ? dueSummary.due_now : '–'}</div>
              <div className="h-glance-card__label">
                {dueSummary && dueSummary.due_now === 0 && dueSummary.next_due_at
                  ? `due · next ${formatNextDue(dueSummary.next_due_at)}`
                  : 'cards due now'}
              </div>
            </Link>
            <button type="button" className="h-glance-card" onClick={handleScrollToDeckReview}>
              <div className="h-glance-card__value">{enabledDeckCount}</div>
              <div className="h-glance-card__label">decks in rotation</div>
            </button>
            <button
              type="button"
              className="h-glance-card"
              aria-expanded={isPracticeSettingsOpen}
              aria-controls="h-settings-panel"
              onClick={handleTogglePracticeSettings}
            >
              <div className="h-glance-card__value">{settings.new_block_size}/{settings.review_batch_size}</div>
              <div className="h-glance-card__label">new / review mix</div>
            </button>
            <button
              type="button"
              className="h-glance-card"
              aria-expanded={isPracticeSettingsOpen}
              aria-controls="h-settings-panel"
              onClick={handleTogglePracticeSettings}
            >
              <div className="h-glance-card__value">{settings.interleaving_intensity}</div>
              <div className="h-glance-card__label">interleaving</div>
            </button>
          </div>
        </div>
      </div>

      {/* ── Practice action cards ─────────────────────────────────── */}
      <div className="h-action-grid">
        <Link
          className="h-action-primary"
          to="/practice"
          onClick={() => updateSettings({ focus_mode: 'auto' })}
        >
          <div className="h-action-primary__top">
            <span className="h-action-kicker">RECOMMENDED</span>
            <span className="h-action-arrow">→</span>
          </div>
          <div>
            <div className="h-action-primary__title">Play Auto</div>
            <div className="h-action-primary__meta">
              {sessionCards} cards · ~{Math.ceil(sessionCards / 2)} min
            </div>
          </div>
        </Link>

        <Link
          className="h-action-secondary"
          to="/practice"
          onClick={() => updateSettings({ focus_mode: 'new_material' })}
        >
          <span className="h-action-kicker h-action-kicker--muted">SESSION</span>
          <div>
            <div className="h-action-secondary__title">New material</div>
            <p className="h-action-secondary__copy">Lean toward fresh cards you haven't met yet.</p>
          </div>
        </Link>

        <Link
          className="h-action-secondary"
          to="/practice"
          onClick={() => updateSettings({ focus_mode: 'review' })}
        >
          <span className="h-action-kicker h-action-kicker--muted">SESSION</span>
          <div>
            <div className="h-action-secondary__title">Review</div>
            <p className="h-action-secondary__copy">
              {(dueSummary?.due_now ?? 0) > 0
                ? `${dueSummary.due_now} card${dueSummary.due_now === 1 ? '' : 's'} due now — clear them before they fade.`
                : 'Settle the cards that are due back today.'}
            </p>
          </div>
        </Link>
      </div>

      {/* ── Practice settings panel ───────────────────────────────── */}
      {shouldRenderPracticeSettings ? (
        <div
          id="h-settings-panel"
          className={`h-settings ${isPracticeSettingsOpen ? 'h-settings--open' : 'h-settings--closing'}`}
        >
          <label className="setting-field">
            <span>New material flashcard count</span>
            <input
              type="range" min="5" max="12"
              value={settings.new_block_size}
              onChange={(e) => updateSettings({ new_block_size: Number(e.target.value) })}
            />
            <strong>{settings.new_block_size} cards</strong>
          </label>

          <label className="setting-field">
            <span>Review stack flashcard count</span>
            <input
              type="range" min="20" max="50" step="5"
              value={settings.review_batch_size}
              onChange={(e) => updateSettings({ review_batch_size: Number(e.target.value) })}
            />
            <strong>{settings.review_batch_size} cards</strong>
          </label>

          <label className="setting-field">
            <span>Interleaving intensity</span>
            <select
              className="setting-field__select"
              value={settings.interleaving_intensity}
              onChange={(e) => updateSettings({ interleaving_intensity: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>

          <div className="smart-practice-panel__controls-copy">
            <div className="smart-practice-panel__controls-copy-block">
              <strong>Session types</strong>
              <ul>
                <li>Auto mixes new material and review for the default run.</li>
                <li>New material biases the session toward fresh cards.</li>
                <li>Review prioritizes pending recall before expanding.</li>
              </ul>
            </div>
            <div className="smart-practice-panel__controls-copy-block">
              <strong>Interleaving intensity</strong>
              <ul>
                <li>Low keeps cards grouped in a steadier rhythm.</li>
                <li>Medium mixes new and review cards more evenly.</li>
                <li>High creates a more varied session with faster alternation.</li>
              </ul>
            </div>
            <div className="smart-practice-panel__controls-copy-block">
              <strong>How progression works</strong>
              <ul>
                <li>New blocks unlock only after each card reaches an initial 2-streak mastery threshold.</li>
                <li>Review misses go back to the end of the queue instead of repeating immediately.</li>
                <li>Mastered cards are scheduled with spaced repetition (FSRS) and come back just before you would forget them.</li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Home decks ────────────────────────────────────────────── */}
      <section className="h-decks" ref={deckReviewSectionRef}>
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
