import { useNavigate } from 'react-router-dom';

function percentage(value) {
  return Math.round(value * 100);
}

function DeckCard({
  deck,
  variant = 'home',
  isPending = false,
  onToggleSmartPractice,
  onToggleHome,
  searchMatchReasons = [],
  isSearchDimmed = false,
}) {
  const navigate = useNavigate();
  const isPracticeEnabled = Boolean(deck.is_enabled_in_smart_practice);
  const isOnHome = Boolean(deck.is_selected_on_home);
  const cardStateClass = variant === 'market'
    ? 'deck-card--market'
    : isPracticeEnabled
      ? 'deck-card--selected'
      : 'deck-card--inactive';

  function handleOpenDeck() {
    navigate(`/decks/${deck.id}/words`);
  }

  function handleTogglePractice() {
    if (variant !== 'home') return;
    onToggleSmartPractice?.(deck.id, !isPracticeEnabled);
  }

  function handleKeyDown(event) {
    if (variant !== 'home') return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleTogglePractice();
    }
  }

  return (
    <article
      className={`panel deck-card ${cardStateClass} ${variant === 'home' ? 'deck-card--home' : ''} ${isSearchDimmed ? 'deck-card--search-dimmed' : ''}`}
      role={variant === 'home' ? 'button' : undefined}
      tabIndex={variant === 'home' ? 0 : undefined}
      aria-pressed={variant === 'home' ? isPracticeEnabled : undefined}
      onClick={handleTogglePractice}
      onKeyDown={handleKeyDown}
    >
      {variant === 'home' || variant === 'market' ? (
        <button
          className="deck-card__explore-button"
          type="button"
          aria-label={`Open ${deck.title} deck explorer`}
          title="Open deck explorer"
          onClick={(event) => {
            event.stopPropagation();
            handleOpenDeck();
          }}
          onKeyDown={(event) => event.stopPropagation()}
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
      ) : null}

      <div className="deck-card__content">
        <div className="deck-card__content-top">
          <div>
            <h3>{deck.title}</h3>
          </div>
        </div>

        {variant === 'market' ? <p className="deck-card__market-description">{deck.description}</p> : null}
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
          {variant === 'home' && deck.description ? (
            <div className="deck-card__description-overlay">
              <div className="deck-card__description-surface">
                <p className="deck-card__description">{deck.description}</p>
              </div>
            </div>
          ) : null}

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

        {variant === 'market' ? (
          <div className="deck-card__actions">
            <button
              className={`deck-card__action-button ${isOnHome ? 'deck-card__action-button--danger' : 'deck-card__action-button--primary'}`}
              type="button"
              disabled={isPending}
              aria-pressed={isOnHome}
              onClick={() => onToggleHome?.(deck.id, !isOnHome)}
            >
              {isOnHome ? 'Remove from home' : 'Add to home'}
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default DeckCard;
