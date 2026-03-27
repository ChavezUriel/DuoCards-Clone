import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDeckPreview, fetchHomeDecks, updateDeckSmartPracticeInclusion } from '../api';
import DeckCard from '../components/DeckCard';
import { loadPracticeSettings, savePracticeSettings } from '../practiceSettings';

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
    .replace(/[\u0300-\u036f]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreFieldMatch(fieldValue, query) {
  if (!fieldValue) {
    return 0;
  }

  const normalizedField = normalizeSearchText(fieldValue);

  if (!normalizedField) {
    return 0;
  }

  if (normalizedField === query) {
    return 120;
  }

  if (normalizedField.startsWith(query)) {
    return 90;
  }

  if (normalizedField.includes(query)) {
    return 70;
  }

  const queryTerms = query.split(' ');
  const matchedTerms = queryTerms.filter((term) => normalizedField.includes(term)).length;
  return matchedTerms === queryTerms.length ? 50 : matchedTerms > 0 ? 20 + matchedTerms : 0;
}

function buildDeckWordIndex(preview) {
  return preview.cards
    .flatMap((card) => [
      card.answer_en,
      card.prompt_es,
      card.section_name,
      card.definition_en,
      ...(card.main_translations_es || []),
      ...(card.collocations || []),
      card.example_sentence,
      card.example_en,
      card.example_es,
    ])
    .filter(Boolean)
    .join(' ');
}

function buildSearchMatchReasons(titleScore, descriptionScore, wordsScore) {
  const reasons = [];

  if (titleScore > 0) {
    reasons.push('Title');
  }

  if (descriptionScore > 0) {
    reasons.push('Description');
  }

  if (wordsScore > 0) {
    reasons.push('Deck words');
  }

  if (reasons.length === 0) {
    return [];
  }

  if (reasons.length === 1) {
    return [`${reasons[0]} match`];
  }

  if (reasons.length === 2) {
    return [`${reasons[0]} & ${reasons[1]} match`];
  }

  return [`${reasons.slice(0, -1).join(', ')} & ${reasons[reasons.length - 1]} match`];
}

function rankDeckSearchResults(decks, query, deckWordIndexById) {
  if (!query) {
    return decks.map((deck) => ({
      deck,
      searchScore: 0,
      searchDidMatch: false,
      searchMatchReasons: [],
    }));
  }

  return decks
    .map((deck, index) => {
      const titleScore = scoreFieldMatch(deck.title, query);
      const descriptionScore = scoreFieldMatch(deck.description, query);
      const wordsScore = scoreFieldMatch(deckWordIndexById[deck.id], query);
      const score = (titleScore * 1_000_000) + (descriptionScore * 1_000) + wordsScore;

      return {
        deck,
        index,
        score,
        searchScore: score,
        searchDidMatch: score > 0,
        searchMatchReasons: buildSearchMatchReasons(titleScore, descriptionScore, wordsScore),
      };
    })
    .sort((leftEntry, rightEntry) => {
      if (leftEntry.searchDidMatch !== rightEntry.searchDidMatch) {
        return leftEntry.searchDidMatch ? -1 : 1;
      }

      if (leftEntry.searchScore !== rightEntry.searchScore) {
        return rightEntry.searchScore - leftEntry.searchScore;
      }

      return leftEntry.index - rightEntry.index;
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
  const deckReviewSectionRef = useRef(null);

  const areAllDecksEnabledInSmartPractice = decks.length > 0
    && decks.every((deck) => deck.is_enabled_in_smart_practice);
  const enabledDeckCount = decks.filter((deck) => deck.is_enabled_in_smart_practice).length;
  const hasPendingDeckUpdates = pendingDeckIds.length > 0;

  function updateSettings(partialSettings) {
    setSettings((current) => {
      const nextSettings = {
        ...current,
        ...partialSettings,
      };
      savePracticeSettings(nextSettings);
      return nextSettings;
    });
  }

  function handleTogglePracticeSettings() {
    setIsPracticeSettingsOpen((current) => !current);
  }

  function handleScrollToDeckReview() {
    deckReviewSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  useEffect(() => {
    if (isPracticeSettingsOpen) {
      setShouldRenderPracticeSettings(true);
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setShouldRenderPracticeSettings(false);
    }, 220);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isPracticeSettingsOpen]);

  useEffect(() => {
    let cancelled = false;

    async function loadDecks() {
      try {
        const nextDecks = await fetchHomeDecks();
        if (!cancelled) {
          setDecks(sortDecksBySmartPractice(nextDecks));
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }

    loadDecks();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDeckWordIndexes() {
      if (decks.length === 0) {
        return;
      }

      const results = await Promise.allSettled(
        decks.map(async (deck) => {
          const preview = await fetchDeckPreview(deck.id);
          return [deck.id, buildDeckWordIndex(preview)];
        })
      );

      if (cancelled) {
        return;
      }

      const nextDeckWordIndexById = {};

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const [deckId, deckWordIndex] = result.value;
          nextDeckWordIndexById[deckId] = deckWordIndex;
        }
      }

      setDeckWordIndexById(nextDeckWordIndexById);
    }

    loadDeckWordIndexes();

    return () => {
      cancelled = true;
    };
  }, [decks]);

  const normalizedSearchQuery = normalizeSearchText(searchQuery);
  const visibleDeckEntries = useMemo(
    () => rankDeckSearchResults(decks, normalizedSearchQuery, deckWordIndexById),
    [deckWordIndexById, decks, normalizedSearchQuery]
  );

  async function updateSmartPracticeInclusion(deckIds, isEnabledInSmartPractice) {
    if (deckIds.length === 0) {
      return;
    }

    setActionError('');
    setPendingDeckIds((current) => uniqueDeckIds([...current, ...deckIds]));

    try {
      const results = await Promise.allSettled(
        deckIds.map((deckId) => updateDeckSmartPracticeInclusion(deckId, isEnabledInSmartPractice))
      );

      const successfulDeckIds = deckIds.filter((deckId, index) => results[index].status === 'fulfilled');
      const failedResults = results.filter((result) => result.status === 'rejected');

      if (successfulDeckIds.length > 0) {
        setDecks((current) => current.map((deck) => (
          successfulDeckIds.includes(deck.id)
            ? { ...deck, is_enabled_in_smart_practice: isEnabledInSmartPractice }
            : deck
        )));
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
      setPendingDeckIds((current) => current.filter((pendingDeckId) => !deckIds.includes(pendingDeckId)));
    }
  }

  async function handleToggleSmartPractice(deckId, isEnabledInSmartPractice) {
    await updateSmartPracticeInclusion([deckId], isEnabledInSmartPractice);
  }

  async function handleToggleAllDecks() {
    const nextEnabledState = !areAllDecksEnabledInSmartPractice;
    const targetDeckIds = decks
      .filter((deck) => deck.is_enabled_in_smart_practice !== nextEnabledState)
      .map((deck) => deck.id);

    await updateSmartPracticeInclusion(targetDeckIds, nextEnabledState);
  }

  if (status === 'loading') {
    return <section className="panel empty-state">Loading your home decks...</section>;
  }

  if (status === 'error') {
    return <section className="panel empty-state">Unable to load decks: {error}</section>;
  }

  if (decks.length === 0) {
    return (
      <section className="panel empty-state">
        <h2>No decks on home</h2>
        <p>Open the deck market and add decks to bring them back here.</p>
        <Link className="button button--primary" to="/market">
          Open market
        </Link>
      </section>
    );
  }

  return (
    <>
      <section className="panel smart-practice-panel hero hero--smart-practice">
        <div className="smart-practice-panel__hero">
          <div className="smart-practice-panel__intro">
            <h1>Smart Practice</h1>

            <div className="smart-practice-panel__glance">
              <button
                className="smart-practice-panel__glance-card smart-practice-panel__glance-card--button"
                type="button"
                onClick={handleScrollToDeckReview}
              >
                <span>Decks in rotation</span>
                <strong>{enabledDeckCount} enabled</strong>
              </button>
              <button
                className="smart-practice-panel__glance-card smart-practice-panel__glance-card--button"
                type="button"
                aria-expanded={isPracticeSettingsOpen}
                aria-controls="smart-practice-settings"
                onClick={handleTogglePracticeSettings}
              >
                <span>Session shape</span>
                <strong>{settings.new_block_size} new / {settings.review_batch_size} review</strong>
              </button>
              <button
                className="smart-practice-panel__glance-card smart-practice-panel__glance-card--button"
                type="button"
                aria-expanded={isPracticeSettingsOpen}
                aria-controls="smart-practice-settings"
                onClick={handleTogglePracticeSettings}
              >
                <span>Interleaving</span>
                <strong>{settings.interleaving_intensity}</strong>
              </button>
            </div>
          </div>

          <div className="smart-practice-panel__play-stage">
            <Link
              className="smart-practice-panel__primary-action"
              to="/practice"
              onClick={() => updateSettings({ focus_mode: 'auto' })}
            >
              <span className="smart-practice-panel__primary-kicker">Recommended</span>
              <strong>Play Auto</strong>
            </Link>

            <div className="smart-practice-panel__secondary-stage">
              <div className="smart-practice-panel__secondary-actions" aria-label="Alternative smart practice modes">
                <Link
                  className="smart-practice-panel__secondary-action"
                  to="/practice"
                  onClick={() => updateSettings({ focus_mode: 'new_material' })}
                >
                  <span className="smart-practice-panel__secondary-kicker">Session</span>
                  <strong>Play New material</strong>
                  <span className="smart-practice-panel__secondary-copy">Start a run biased toward fresh cards.</span>
                </Link>

                <Link
                  className="smart-practice-panel__secondary-action"
                  to="/practice"
                  onClick={() => updateSettings({ focus_mode: 'review' })}
                >
                  <span className="smart-practice-panel__secondary-kicker">Session</span>
                  <strong>Play Review</strong>
                  <span className="smart-practice-panel__secondary-copy">Start a run focused on pending recall.</span>
                </Link>
              </div>
            </div>
          </div>
        </div>

        {shouldRenderPracticeSettings ? (
          <div
            className={`smart-practice-panel__controls ${isPracticeSettingsOpen ? 'smart-practice-panel__controls--open' : 'smart-practice-panel__controls--closing'}`}
            id="smart-practice-settings"
          >
            <label className="setting-field">
              <span>New material flashcard count</span>
              <input
                type="range"
                min="5"
                max="12"
                value={settings.new_block_size}
                onChange={(event) => updateSettings({ new_block_size: Number(event.target.value) })}
              />
              <strong>{settings.new_block_size} cards</strong>
            </label>

            <label className="setting-field">
              <span>Review stack flashcard count</span>
              <input
                type="range"
                min="20"
                max="50"
                step="5"
                value={settings.review_batch_size}
                onChange={(event) => updateSettings({ review_batch_size: Number(event.target.value) })}
              />
              <strong>{settings.review_batch_size} cards</strong>
            </label>

            <label className="setting-field">
              <span>Interleaving intensity</span>
              <select
                className="setting-field__select"
                value={settings.interleaving_intensity}
                onChange={(event) => updateSettings({ interleaving_intensity: event.target.value })}
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
                  <li>High creates a more varied session with faster alternation between card types.</li>
                </ul>
              </div>
              <div className="smart-practice-panel__controls-copy-block">
                <strong>How progression works</strong>
                <ul>
                  <li>New blocks unlock only after each card reaches an initial 2-streak mastery threshold.</li>
                  <li>Review misses go back to the end of the queue instead of repeating immediately.</li>
                </ul>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="home-section home-section--secondary" ref={deckReviewSectionRef}>
        <div className="section-heading">
          <div>
            <h2>Home Decks</h2>
          </div>

          <div className="section-controls">
            <Link to="/market" className="button button--secondary">
              Open market
            </Link>
            <label className="deck-search" aria-label="Search decks">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search home decks"
              />
            </label>

            <label className="section-toggle" aria-label="Toggle Smart Practice sampling for all home decks">
              <span className="section-toggle__copy">
                <strong>All home decks</strong>
                <small>{enabledDeckCount} of {decks.length} enabled</small>
              </span>
              <button
                className={`section-toggle__switch ${areAllDecksEnabledInSmartPractice ? 'section-toggle__switch--active' : ''}`}
                type="button"
                role="switch"
                aria-checked={areAllDecksEnabledInSmartPractice}
                aria-label={areAllDecksEnabledInSmartPractice ? 'Disable all home decks for Smart Practice sampling' : 'Enable all home decks for Smart Practice sampling'}
                onClick={handleToggleAllDecks}
                disabled={hasPendingDeckUpdates || decks.length === 0}
              >
                <span className="section-toggle__thumb" aria-hidden="true" />
              </button>
            </label>
          </div>
        </div>

        {actionError ? <p className="deck-grid__status deck-grid__status--error">{actionError}</p> : null}

        <div className="deck-grid">
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
