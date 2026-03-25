import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchDeckPreview, updateCard, updateCardVisibility } from '../api';
import CardDetailsModal from '../components/CardDetailsModal';

const GRID_COLUMNS = 4;
const GRID_ROWS = 5;
const PAGE_SIZE = GRID_COLUMNS * GRID_ROWS;

function DeckWordsPage() {
  const { deckId } = useParams();
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pendingCardIds, setPendingCardIds] = useState([]);
  const [actionError, setActionError] = useState('');
  const [detailsModalState, setDetailsModalState] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDeckPreview() {
      try {
        setStatus('loading');
        setError('');
        setActionError('');
        const nextPreview = await fetchDeckPreview(deckId);
        if (!cancelled) {
          setPreview(nextPreview);
          setCurrentPage(1);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }

    loadDeckPreview();

    return () => {
      cancelled = true;
    };
  }, [deckId]);

  if (status === 'loading') {
    return <section className="panel empty-state">Loading deck words...</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>There was a problem loading the deck words.</p>
        <p>{error}</p>
        <Link className="button button--secondary" to="/">
          Back to decks
        </Link>
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(preview.cards.length / PAGE_SIZE));
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;
  const visibleCards = preview.cards.slice(pageStart, pageEnd);
  const detailsCard = detailsModalState
    ? preview.cards.find((card) => card.card_id === detailsModalState.cardId) ?? null
    : null;

  async function handleToggleCard(cardId, isEnabled) {
    setActionError('');
    setPendingCardIds((current) => [...current, cardId]);

    try {
      await updateCardVisibility(cardId, isEnabled);
      setPreview((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          cards: current.cards.map((card) => (
            card.card_id === cardId
              ? { ...card, is_enabled: isEnabled }
              : card
          )),
        };
      });
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setPendingCardIds((current) => current.filter((pendingCardId) => pendingCardId !== cardId));
    }
  }

  async function handleSaveCard(cardId, values) {
    setActionError('');
    setPendingCardIds((current) => [...current, cardId]);

    try {
      const updatedCard = await updateCard(cardId, values);
      setPreview((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          cards: current.cards.map((card) => (
            card.card_id === cardId
              ? updatedCard
              : card
          )),
        };
      });
      return updatedCard;
    } catch (requestError) {
      setActionError(requestError.message);
      return null;
    } finally {
      setPendingCardIds((current) => current.filter((pendingCardId) => pendingCardId !== cardId));
    }
  }

  return (
    <section className="panel deck-preview-page">
      <div className="deck-preview-page__toolbar">
        <Link className="back-link" to="/">
          Back to decks
        </Link>
        <Link className="button button--secondary" to={`/review/${preview.deck_id}`}>
          Start review
        </Link>
      </div>

      <div className="deck-preview__header-row">
        <div className="deck-preview__header">
          <p className="eyebrow">Deck explorer</p>
          <h2>{preview.deck_title}</h2>
          <p className="deck-preview__description">{preview.deck_description}</p>
        </div>

        {preview.cards.length ? (
          <div className="deck-preview__pagination deck-preview__pagination--header">
            <button
              className="deck-preview__pagination-arrow"
              type="button"
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              disabled={currentPage === 1}
              aria-label="Previous page"
              title="Previous page"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M14.5 6.5 9 12l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <p className="deck-preview__pagination-status">
              Showing {pageStart + 1}-{Math.min(pageEnd, preview.cards.length)} of {preview.cards.length}
            </p>

            <button
              className="deck-preview__pagination-arrow"
              type="button"
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              disabled={currentPage === totalPages}
              aria-label="Next page"
              title="Next page"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9.5 6.5 15 12l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>

      {actionError ? <p className="deck-preview__status deck-preview__status--error">{actionError}</p> : null}

      {preview.cards.length ? (
        <>
          <ul className="deck-preview__grid">
            {visibleCards.map((card) => (
              <DeckWordCard
                key={card.card_id}
                card={card}
                isPending={pendingCardIds.includes(card.card_id)}
                onEdit={() => setDetailsModalState({ cardId: card.card_id, startInEditMode: true })}
                onOpenDetails={() => setDetailsModalState({ cardId: card.card_id, startInEditMode: false })}
                onToggle={() => handleToggleCard(card.card_id, !card.is_enabled)}
              />
            ))}
            {Array.from({ length: Math.max(0, PAGE_SIZE - visibleCards.length) }).map((_, index) => (
              <li key={`placeholder-${index}`} className="deck-preview__item deck-preview__item--placeholder" aria-hidden="true" />
            ))}
          </ul>
        </>
      ) : (
        <p className="deck-preview__status">This deck has no cards yet.</p>
      )}

      {detailsCard ? (
        <CardDetailsModal
          card={detailsCard}
          isPending={pendingCardIds.includes(detailsCard.card_id)}
          startInEditMode={detailsModalState?.startInEditMode ?? false}
          onClose={() => setDetailsModalState(null)}
          onSave={(values) => handleSaveCard(detailsCard.card_id, values)}
          onToggle={() => handleToggleCard(detailsCard.card_id, !detailsCard.is_enabled)}
        />
      ) : null}
    </section>
  );
}

function DeckWordCard({ card, isPending, onToggle, onEdit, onOpenDetails }) {
  const toggleLabel = card.is_enabled ? `Hide card ${card.prompt_es}` : `Show card ${card.prompt_es}`;
  const toggleTitle = card.is_enabled ? 'Hide card from deck' : 'Show card in deck again';

  return (
    <li className={`deck-preview__item ${card.is_enabled ? '' : 'deck-preview__item--disabled'}`}>

      <div className="deck-preview__languages">
        <div>
          <strong>{card.prompt_es}</strong>
        </div>
        <div>
          <p>{card.answer_en}</p>
        </div>
      </div>

      <div className="deck-preview__actions">
        <button
          className="deck-preview__icon-button"
          type="button"
          aria-label={toggleLabel}
          title={toggleTitle}
          onClick={onToggle}
          disabled={isPending}
        >
          {card.is_enabled ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="800px" height="800px" viewBox="0 0 24 24" fill="none">
              <path d="M15.0007 12C15.0007 13.6569 13.6576 15 12.0007 15C10.3439 15 9.00073 13.6569 9.00073 12C9.00073 10.3431 10.3439 9 12.0007 9C13.6576 9 15.0007 10.3431 15.0007 12Z" stroke="#000000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M12.0012 5C7.52354 5 3.73326 7.94288 2.45898 12C3.73324 16.0571 7.52354 19 12.0012 19C16.4788 19 20.2691 16.0571 21.5434 12C20.2691 7.94291 16.4788 5 12.0012 5Z" stroke="#000000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
</svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="800px" height="800px" viewBox="0 0 24 24" fill="none">
              <path d="M2.99902 3L20.999 21M9.8433 9.91364C9.32066 10.4536 8.99902 11.1892 8.99902 12C8.99902 13.6569 10.3422 15 11.999 15C12.8215 15 13.5667 14.669 14.1086 14.133M6.49902 6.64715C4.59972 7.90034 3.15305 9.78394 2.45703 12C3.73128 16.0571 7.52159 19 11.9992 19C13.9881 19 15.8414 18.4194 17.3988 17.4184M10.999 5.04939C11.328 5.01673 11.6617 5 11.9992 5C16.4769 5 20.2672 7.94291 21.5414 12C21.2607 12.894 20.8577 13.7338 20.3522 14.5" stroke="#000000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
</svg>
          )}
        </button>

        <button
          className="deck-preview__icon-button deck-preview__icon-button--muted"
          type="button"
          aria-label={`Edit card ${card.prompt_es}`}
          title="Edit card"
          onClick={onEdit}
          disabled={isPending}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 20h4.2L19 9.2a1.5 1.5 0 0 0 0-2.1l-2.1-2.1a1.5 1.5 0 0 0-2.1 0L4 15.8V20Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M13.5 6.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          className="deck-preview__icon-button deck-preview__icon-button--muted"
          type="button"
          aria-label={`Show metadata for ${card.prompt_es}`}
          title="Show flashcard metadata"
          onClick={onOpenDetails}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="5" cy="12" r="1.7" fill="currentColor" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
            <circle cx="19" cy="12" r="1.7" fill="currentColor" />
          </svg>
        </button>
      </div>

    </li>
  );
}

export default DeckWordsPage;