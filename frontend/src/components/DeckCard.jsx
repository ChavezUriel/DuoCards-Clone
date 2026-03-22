import { Link } from 'react-router-dom';

function percentage(value) {
  return Math.round(value * 100);
}

function DeckCard({ deck, isPending = false, onToggleSmartPractice }) {
  const smartPracticeLabel = deck.is_enabled_in_smart_practice
    ? `Exclude ${deck.title} from Smart Practice`
    : `Include ${deck.title} in Smart Practice`;
  const smartPracticeTitle = deck.is_enabled_in_smart_practice
    ? 'Disable deck for Smart Practice'
    : 'Enable deck for Smart Practice';

  return (
    <article className={`panel deck-card ${deck.is_enabled_in_smart_practice ? '' : 'deck-card--inactive'}`}>
      <div className="deck-card__content">
        <p className="deck-card__label">Deck</p>
        <h2>{deck.title}</h2>
        <p>{deck.description}</p>
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
        </div>

        <div className="deck-card__footer">
          <div className="deck-card__actions">
            <Link
              className="deck-card__icon-button"
              to={`/decks/${deck.id}/words`}
              aria-label={`Explore ${deck.title}`}
              title="Explore deck"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M5 7.25h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M5 16.75h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <circle cx="3.75" cy="7.25" r="1" fill="currentColor" />
                <circle cx="3.75" cy="12" r="1" fill="currentColor" />
                <circle cx="3.75" cy="16.75" r="1" fill="currentColor" />
              </svg>
            </Link>

            <button
              className={`deck-card__icon-button ${deck.is_enabled_in_smart_practice ? '' : 'deck-card__icon-button--inactive'}`}
              type="button"
              aria-label={smartPracticeLabel}
              title={smartPracticeTitle}
              onClick={() => onToggleSmartPractice(deck.id, !deck.is_enabled_in_smart_practice)}
              disabled={isPending}
            >
              {deck.is_enabled_in_smart_practice ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M2.45 12C3.73 7.95 7.52 5 12 5s8.27 2.95 9.55 7c-1.28 4.05-5.07 7-9.55 7s-8.27-2.95-9.55-7Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="12" cy="12" r="3.35" fill="none" stroke="currentColor" strokeWidth="1.9" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M10.73 5.08C11.14 5.03 11.57 5 12 5c7 0 11 7 11 7a13.6 13.6 0 0 1-1.67 2.68" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M6.61 6.61A13.2 13.2 0 0 0 1 12s4 7 11 7a10.8 10.8 0 0 0 5.39-1.39" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M3 3l18 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export default DeckCard;
