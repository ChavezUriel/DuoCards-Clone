import { Link } from 'react-router-dom';

function percentage(value) {
  return Math.round(value * 100);
}

function DeckCard({ deck }) {
  const actionLabel = deck.is_completed ? 'Practice again' : 'Start review';
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
        <Link className="button button--primary" to={`/review/${deck.id}`}>
          {actionLabel}
        </Link>
      </div>
    </article>
  );
}

export default DeckCard;
