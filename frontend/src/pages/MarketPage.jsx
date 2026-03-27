import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchMarketDecks, updateDeckHomeSelection } from '../api';
import DeckCard from '../components/DeckCard';

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M4 10.5 12 4l8 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 9.75V20h11V9.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20v-5.25h4V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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

function sortDecks(decks) {
  return [...decks].sort((leftDeck, rightDeck) => {
    const leftHome = leftDeck.is_selected_on_home ? 1 : 0;
    const rightHome = rightDeck.is_selected_on_home ? 1 : 0;
    if (leftHome !== rightHome) {
      return rightHome - leftHome;
    }

    if (leftDeck.completion_ratio !== rightDeck.completion_ratio) {
      return rightDeck.completion_ratio - leftDeck.completion_ratio;
    }

    return leftDeck.title.localeCompare(rightDeck.title);
  });
}

function MarketPage() {
  const [decks, setDecks] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [pendingDeckIds, setPendingDeckIds] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadDecks() {
      try {
        const nextDecks = await fetchMarketDecks();
        if (!cancelled) {
          setDecks(sortDecks(nextDecks));
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

  const normalizedSearchQuery = normalizeSearchText(searchQuery);
  const visibleDecks = useMemo(() => {
    if (!normalizedSearchQuery) {
      return decks;
    }

    return decks.filter((deck) => {
      const titleMatch = normalizeSearchText(deck.title).includes(normalizedSearchQuery);
      const descriptionMatch = normalizeSearchText(deck.description).includes(normalizedSearchQuery);
      return titleMatch || descriptionMatch;
    });
  }, [decks, normalizedSearchQuery]);

  async function handleToggleHome(deckId, isSelectedOnHome) {
    setPendingDeckIds((current) => [...current, deckId]);

    try {
      await updateDeckHomeSelection(deckId, isSelectedOnHome);
      // Update selection state but do NOT re-sort while the market page is open.
      // The ordering should be generated when the market screen is opened.
      setDecks((current) => current.map((deck) => (deck.id === deckId ? { ...deck, is_selected_on_home: isSelectedOnHome } : deck)));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPendingDeckIds((current) => current.filter((pendingDeckId) => pendingDeckId !== deckId));
    }
  }

  if (status === 'loading') {
    return <section className="panel empty-state">Loading deck market...</section>;
  }

  if (status === 'error') {
    return <section className="panel empty-state">Unable to load market: {error}</section>;
  }

  return (
    <section className="home-section home-section--secondary">
      <div className="section-heading">
        <div>
          <Link to="/" className="back-link back-link--home back-link--button">
            <HomeIcon />
            <span>Home</span>
          </Link>
          <h2>Choose decks for home</h2>
          <p className="hero-copy">Select decks you want on your home screen. You can remove them later.</p>
        </div>

        <div className="section-controls">
          <label className="deck-search" aria-label="Search market decks">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search market"
            />
          </label>
        </div>
      </div>

      {visibleDecks.length === 0 ? (
        <section className="panel empty-state">
          <p>{decks.length === 0 ? 'All decks are already on your home screen.' : 'No market decks match your search.'}</p>
          <Link to="/" className="button button--primary">
            Back home
          </Link>
        </section>
      ) : (
        <div className="deck-grid">
          {visibleDecks.map((deck) => (
            <DeckCard
              key={deck.id}
              deck={deck}
              variant="market"
              isPending={pendingDeckIds.includes(deck.id)}
              onToggleHome={handleToggleHome}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default MarketPage;
