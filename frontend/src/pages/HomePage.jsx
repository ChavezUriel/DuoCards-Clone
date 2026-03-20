import { useEffect, useState } from 'react';
import { fetchDecks } from '../api';
import DeckCard from '../components/DeckCard';

function HomePage() {
  const [decks, setDecks] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadDecks() {
      try {
        const nextDecks = await fetchDecks();
        if (!cancelled) {
          setDecks(nextDecks);
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

  if (status === 'loading') {
    return <section className="panel empty-state">Loading starter decks...</section>;
  }

  if (status === 'error') {
    return <section className="panel empty-state">Unable to load decks: {error}</section>;
  }

  return (
    <section className="deck-grid">
      {decks.map((deck) => (
        <DeckCard key={deck.id} deck={deck} />
      ))}
    </section>
  );
}

export default HomePage;
