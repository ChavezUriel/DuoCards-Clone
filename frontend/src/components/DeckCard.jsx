import { useNavigate } from 'react-router-dom';

function percentage(value) {
  return Math.round(value * 100);
}

function DeckCard({
  deck,
  isPending = false,
  onToggleSmartPractice,
  searchMatchReasons = [],
  isSearchDimmed = false,
}) {
  const navigate = useNavigate();
  const isSelected = deck.is_enabled_in_smart_practice;
  const selectionLabel = isSelected
    ? `Remove ${deck.title} from Smart Practice sampling`
    : `Add ${deck.title} to Smart Practice sampling`;
  const explorerLabel = `Open ${deck.title} deck explorer`;

  function handleOpenDeck() {
    navigate(`/decks/${deck.id}/words`);
  }

  function handleCardKeyDown(event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggleSmartPractice(deck.id, !isSelected);
    }
  }

  function handleOpenDeckClick(event) {
    event.stopPropagation();
    handleOpenDeck();
  }

  return (
    <article
      className={`panel deck-card ${isSelected ? 'deck-card--selected' : 'deck-card--inactive'} ${isSearchDimmed ? 'deck-card--search-dimmed' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={selectionLabel}
      aria-pressed={isSelected}
      onClick={() => onToggleSmartPractice(deck.id, !isSelected)}
      onKeyDown={handleCardKeyDown}
    >
      <button
        className="deck-card__explore-button"
        type="button"
        aria-label={explorerLabel}
        title="Open deck explorer"
        onClick={handleOpenDeckClick}
      >
        <svg fill="#000000" viewBox="0 0 36 36" version="1.1" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
          <g id="SVGRepo_bgCarrier" strokeWidth="0" />
          <g id="SVGRepo_tracerCarrier" strokeLinecap="round" strokeLinejoin="round" />
          <g id="SVGRepo_iconCarrier">
            <title>Deck Cards Explorer</title>
            <path className="clr-i-outline clr-i-outline-path-1" d="M15,17H4a2,2,0,0,1-2-2V8A2,2,0,0,1,4,6H15a2,2,0,0,1,2,2v7A2,2,0,0,1,15,17ZM4,8v7H15V8Z" />
            <path className="clr-i-outline clr-i-outline-path-2" d="M32,17H21a2,2,0,0,1-2-2V8a2,2,0,0,1,2-2H32a2,2,0,0,1,2,2v7A2,2,0,0,1,32,17ZM21,8v7H32V8Z" />
            <path className="clr-i-outline clr-i-outline-path-3" d="M15,30H4a2,2,0,0,1-2-2V21a2,2,0,0,1,2-2H15a2,2,0,0,1,2,2v7A2,2,0,0,1,15,30ZM4,21v7H15V21Z" />
            <path className="clr-i-outline clr-i-outline-path-4" d="M32,30H21a2,2,0,0,1-2-2V21a2,2,0,0,1,2-2H32a2,2,0,0,1,2,2v7A2,2,0,0,1,32,30ZM21,21v7H32V21Z" />
            <rect x="0" y="0" width="36" height="36" fillOpacity="0" />
          </g>
        </svg>
      </button>

        <div className="deck-card__content">
        <h3>{deck.title}</h3>
      </div>

      <div className="deck-card__bottom">
        {searchMatchReasons.length > 0 ? (
          <div className="deck-card__match-reasons" aria-label={`Search matches for ${deck.title}`}>
            {searchMatchReasons.map((reason) => (
              <span key={reason} className="deck-card__match-badge">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <span>{reason}</span>
              </span>
            ))}
          </div>
        ) : null}

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
