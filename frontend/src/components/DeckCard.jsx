import { useNavigate } from 'react-router-dom';

function percentage(value) {
  return Math.round(value * 100);
}

function DeckCard({ deck, isPending = false, onToggleSmartPractice }) {
  const navigate = useNavigate();
  const smartPracticeLabel = deck.is_enabled_in_smart_practice
    ? `Remove ${deck.title} from Smart Practice sampling`
    : `Add ${deck.title} to Smart Practice sampling`;
  const smartPracticeTitle = deck.is_enabled_in_smart_practice
    ? 'Included in Smart Practice sampling'
    : 'Excluded from Smart Practice sampling';

  function handleOpenDeck() {
    navigate(`/decks/${deck.id}/words`);
  }

  function handleCardKeyDown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleOpenDeck();
    }
  }

  function handleToggleClick(event) {
    event.stopPropagation();
    onToggleSmartPractice(deck.id, !deck.is_enabled_in_smart_practice);
  }

  return (
    <article
      className={`panel deck-card ${deck.is_enabled_in_smart_practice ? '' : 'deck-card--inactive'}`}
      role="link"
      tabIndex={0}
      aria-label={`Open ${deck.title} deck`}
      onClick={handleOpenDeck}
      onKeyDown={handleCardKeyDown}
    >
      <button
        className={`deck-card__icon-button deck-card__toggle-button ${deck.is_enabled_in_smart_practice ? 'deck-card__icon-button--selected' : 'deck-card__icon-button--inactive'}`}
        type="button"
        aria-label={smartPracticeLabel}
        title={smartPracticeTitle}
        onClick={handleToggleClick}
        disabled={isPending}
      >
        {deck.is_enabled_in_smart_practice ? (
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.9" />
            <path d="m8.7 12.15 2.2 2.2 4.45-4.45" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.9" />
            <path d="m8.7 12.15 2.2 2.2 4.45-4.45" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <div className="deck-card__content">
        <h2>{deck.title}</h2>
      </div>

      <div className="deck-card__bottom">
        <div className="deck-card__progress-block">
          <div className="deck-card__progress-meta" aria-label={`Progress for ${deck.title}`}>
            <div>
              <span className="deck-card__progress-label">Seen</span>
              <strong>{deck.reviewed_cards}</strong>
            </div>
            <div>
              <span className="deck-card__progress-label">Revisit</span>
              <strong>{deck.unknown_cards}</strong>
            </div>
            <div>
              <span className="deck-card__progress-label">Total</span>
              <strong>{deck.total_cards}</strong>
            </div>
          </div>

          <div className="progress-track" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${percentage(deck.completion_ratio)}%` }} />
          </div>

          <div className="deck-card__description-overlay" aria-hidden="true">
            <div className="deck-card__description-surface">
              <p className="deck-card__description">{deck.description}</p>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

export default DeckCard;
