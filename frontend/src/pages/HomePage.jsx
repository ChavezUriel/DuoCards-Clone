import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDecks, updateDeckSmartPracticeInclusion } from '../api';
import DeckCard from '../components/DeckCard';
import { loadPracticeSettings, savePracticeSettings } from '../practiceSettings';

function uniqueDeckIds(deckIds) {
  return [...new Set(deckIds)];
}

function sortDecksBySmartPractice(decks) {
  return [...decks].sort((leftDeck, rightDeck) => {
    if (leftDeck.is_enabled_in_smart_practice === rightDeck.is_enabled_in_smart_practice) {
      return 0;
    }

    return leftDeck.is_enabled_in_smart_practice ? -1 : 1;
  });
}

function HomePage() {
  const [decks, setDecks] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(() => loadPracticeSettings());
  const [pendingDeckIds, setPendingDeckIds] = useState([]);
  const [actionError, setActionError] = useState('');

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

  useEffect(() => {
    let cancelled = false;

    async function loadDecks() {
      try {
        const nextDecks = await fetchDecks();
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
        setDecks((current) => sortDecksBySmartPractice(current.map((deck) => (
          successfulDeckIds.includes(deck.id)
            ? { ...deck, is_enabled_in_smart_practice: isEnabledInSmartPractice }
            : deck
        ))));
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
    return <section className="panel empty-state">Loading starter decks...</section>;
  }

  if (status === 'error') {
    return <section className="panel empty-state">Unable to load decks: {error}</section>;
  }

  return (
    <>
      <section className="panel smart-practice-panel">
        <div className="smart-practice-panel__intro">
          <p className="eyebrow">Main workflow</p>
          <h2>Smart Practice</h2>
          <p>
            Mix sections across decks, keep new material in small blocks, and push failed review cards to the end of the stack for wider spacing.
          </p>
        </div>

        <div className="smart-practice-panel__controls">
          <label className="setting-field">
            <span>New material block</span>
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
            <span>Review stack</span>
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
              value={settings.interleaving_intensity}
              onChange={(event) => updateSettings({ interleaving_intensity: event.target.value })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>

          <label className="setting-field">
            <span>Session focus</span>
            <select
              value={settings.focus_mode}
              onChange={(event) => updateSettings({ focus_mode: event.target.value })}
            >
              <option value="auto">Auto</option>
              <option value="new_material">New material</option>
              <option value="review">Review</option>
            </select>
          </label>
        </div>

        <div className="smart-practice-panel__footer">
          <div className="smart-practice-panel__summary">
            <span>New blocks unlock only after each card reaches an initial 2-streak mastery threshold.</span>
            <span>Review misses go back to the end of the queue instead of repeating immediately.</span>
          </div>
          <Link className="button button--primary" to="/practice">
            Start Smart Practice
          </Link>
        </div>
      </section>

      <section>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Secondary workflow</p>
            <h2>Deck Review</h2>
          </div>

          <label className="section-toggle" aria-label="Toggle Smart Practice sampling for all decks">
            <span className="section-toggle__copy">
              <strong>All decks</strong>
              <small>{enabledDeckCount} of {decks.length} enabled</small>
            </span>
            <button
              className={`section-toggle__switch ${areAllDecksEnabledInSmartPractice ? 'section-toggle__switch--active' : ''}`}
              type="button"
              role="switch"
              aria-checked={areAllDecksEnabledInSmartPractice}
              aria-label={areAllDecksEnabledInSmartPractice ? 'Disable all decks for Smart Practice sampling' : 'Enable all decks for Smart Practice sampling'}
              onClick={handleToggleAllDecks}
              disabled={hasPendingDeckUpdates || decks.length === 0}
            >
              <span className="section-toggle__thumb" aria-hidden="true" />
            </button>
          </label>
        </div>

        {actionError ? <p className="deck-grid__status deck-grid__status--error">{actionError}</p> : null}

        <div className="deck-grid">
          {decks.map((deck) => (
            <DeckCard
              key={deck.id}
              deck={deck}
              isPending={pendingDeckIds.includes(deck.id)}
              onToggleSmartPractice={handleToggleSmartPractice}
            />
          ))}
        </div>
      </section>
    </>
  );
}

export default HomePage;
