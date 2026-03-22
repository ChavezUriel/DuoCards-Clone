import { Link } from 'react-router-dom';

function percentage(value) {
  return Math.round(value * 100);
}

function DeckCard({ deck }) {
  const actionLabel = deck.is_completed ? 'Open deck review' : 'Review this deck';
  const statusLabel = deck.is_completed
    ? 'All cards known. You can revisit this deck anytime.'
    : `${percentage(deck.completion_ratio)}% reviewed`;

  return (
    <article className="panel deck-card">
      <div className="deck-card__content">
        <p className="deck-card__label">Deck</p>
        <h2>{deck.title}</h2>
        <p>{deck.description}</p>
      </div>

      <div className="deck-card__stats">
        <span>{deck.total_cards} cards</span>
        <span>{deck.known_cards} known</span>
        <span>{deck.unknown_cards} to revisit</span>
      </div>

      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${percentage(deck.completion_ratio)}%` }} />
      </div>

      <div className="deck-card__footer">
        <strong>{statusLabel}</strong>
        <div className="deck-card__actions">
          <Link
            className="deck-card__icon-button"
            to={`/decks/${deck.id}/words`}
            aria-label={`Explore ${deck.title}`}
            title="Explore deck"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M1.5 12s3.9-6.5 10.5-6.5S22.5 12 22.5 12s-3.9 6.5-10.5 6.5S1.5 12 1.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
            </svg>
          </Link>

          <Link className="button button--secondary" to={`/review/${deck.id}`}>
            {actionLabel}
          </Link>
        </div>
      </div>
    </article>
  );
}

export default DeckCard;
