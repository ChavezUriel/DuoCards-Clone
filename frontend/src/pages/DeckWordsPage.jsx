import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { claimMarketDeck, fetchDeckPreview, updateCard, updateCardVisibility } from '../api';
import CardDetailsModal from '../components/CardDetailsModal';
import DeckSyncModal from '../components/DeckSyncModal';
import ProposeChangesModal from '../components/ProposeChangesModal';
import { buildHighlightSegments, normalizeSearchText, scoreFieldMatch } from '../textSearch';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'visible', label: 'Visible' },
  { value: 'hidden', label: 'Hidden' },
];

const SORT_ACCESSORS = {
  word: (card) => card.prompt_es ?? '',
  translation: (card) => card.answer_en ?? '',
  section: (card) => card.section_name ?? '',
};

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M4 10.5 12 4l8 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 9.75V20h11V9.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20v-5.25h4V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Score one card against a normalized query. The headline word pair
// (Spanish prompt / English answer) outranks everything, alternate word forms
// (translations, synonyms) come second, and the long-form metadata fields
// only ever break ties. `matchedIn` names the field that carried the match
// when the headline pair itself did not hit.
function scoreCardMatch(card, query) {
  const wordScore = Math.max(
    scoreFieldMatch(card.prompt_es, query),
    scoreFieldMatch(card.answer_en, query),
  );

  const translationsScore = (card.main_translations_es ?? [])
    .reduce((best, value) => Math.max(best, scoreFieldMatch(value, query)), 0);
  const synonymsScore = (card.synonyms_en ?? [])
    .reduce((best, value) => Math.max(best, scoreFieldMatch(value, query)), 0);
  const altWordScore = Math.max(translationsScore, synonymsScore);

  const secondaryFields = [
    ['section', card.section_name],
    ['part of speech', card.part_of_speech],
    ['definition', card.definition_en],
    ['collocations', (card.collocations ?? []).join(' ')],
    ['examples', [card.example_sentence, card.example_es, card.example_en].filter(Boolean).join(' ')],
  ];
  let secondaryScore = 0;
  let secondaryLabel = null;
  for (const [label, value] of secondaryFields) {
    const fieldScore = scoreFieldMatch(value, query);
    if (fieldScore > secondaryScore) {
      secondaryScore = fieldScore;
      secondaryLabel = label;
    }
  }

  const score = (wordScore * 1_000_000) + (altWordScore * 1_000) + secondaryScore;

  let matchedIn = null;
  if (score > 0 && wordScore === 0) {
    matchedIn = altWordScore > 0
      ? (translationsScore >= synonymsScore ? 'translations' : 'synonyms')
      : secondaryLabel;
  }

  return { score, matchedIn };
}

function HighlightText({ text, query }) {
  if (!text) {
    return null;
  }
  if (!query) {
    return text;
  }
  return buildHighlightSegments(text, query).map((segment, index) => (
    segment.isMatch
      ? <mark key={index} className="deck-table__mark">{segment.text}</mark>
      : <span key={index}>{segment.text}</span>
  ));
}

function SortableHeader({ label, sortKey, sort, onSort, className = '' }) {
  const isActive = sort.key === sortKey;
  return (
    <th
      className={className}
      aria-sort={isActive ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
    >
      <button
        className={`deck-table__sort ${isActive ? 'deck-table__sort--active' : ''}`}
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        <span>{label}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {!isActive ? (
            <>
              <path d="m8 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="m8 14 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : sort.dir === 1 ? (
            <path d="m7 14 5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </button>
    </th>
  );
}

function DeckWordsPage() {
  const { deckId } = useParams();
  const location = useLocation();
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [pendingCardIds, setPendingCardIds] = useState([]);
  const [actionError, setActionError] = useState('');
  const [detailsModalState, setDetailsModalState] = useState(null);
  const [activeSyncModal, setActiveSyncModal] = useState(null); // 'sync' | 'propose' | null
  const [previewRefreshToken, setPreviewRefreshToken] = useState(0);
  const [isClaimPending, setIsClaimPending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const tableScrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDeckPreview() {
      try {
        if (previewRefreshToken === 0) {
          setStatus('loading');
        }
        setError('');
        setActionError('');
        const nextPreview = await fetchDeckPreview(deckId);
        if (!cancelled) {
          setPreview(nextPreview);
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
  }, [deckId, previewRefreshToken]);

  // Navigating to a different deck starts from a clean slate again.
  useEffect(() => {
    setPreviewRefreshToken(0);
    setActiveSyncModal(null);
    setSearchQuery('');
    setStatusFilter('all');
    setSort({ key: null, dir: 1 });
  }, [deckId]);

  const normalizedQuery = normalizeSearchText(searchQuery);

  const tableRows = useMemo(() => {
    if (!preview) {
      return [];
    }

    let rows = preview.cards.map((card, index) => ({ card, index, score: 0, matchedIn: null }));

    if (normalizedQuery) {
      rows = rows
        .map((row) => ({ ...row, ...scoreCardMatch(row.card, normalizedQuery) }))
        .filter((row) => row.score > 0);
    }

    if (statusFilter !== 'all') {
      rows = rows.filter((row) => (statusFilter === 'visible' ? row.card.is_enabled : !row.card.is_enabled));
    }

    if (sort.key) {
      const accessor = SORT_ACCESSORS[sort.key];
      rows = [...rows].sort((left, right) => {
        const leftValue = accessor(left.card);
        const rightValue = accessor(right.card);
        // Cards without a value sink to the bottom in either direction.
        if (!leftValue && !rightValue) return left.index - right.index;
        if (!leftValue) return 1;
        if (!rightValue) return -1;
        const compared = leftValue.localeCompare(rightValue, undefined, { sensitivity: 'base' }) * sort.dir;
        return compared || left.index - right.index;
      });
    } else if (normalizedQuery) {
      rows = [...rows].sort((left, right) => (right.score - left.score) || (left.index - right.index));
    }

    return rows;
  }, [preview, normalizedQuery, statusFilter, sort]);

  // A new query, filter, or sort order should be read from the top.
  useEffect(() => {
    tableScrollRef.current?.scrollTo?.({ top: 0 });
  }, [normalizedQuery, statusFilter, sort]);

  if (status === 'loading') {
    return <section className="panel empty-state">Loading deck words...</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>There was a problem loading the deck words.</p>
        <p>{error}</p>
        <Link className="back-link back-link--home back-link--button" to="/">
          <HomeIcon />
          <span>Back to home</span>
        </Link>
      </section>
    );
  }

  const from = location?.state?.from;
  const backPath = from === 'market' ? '/market' : '/';
  const backLabel = from === 'market' ? 'Back to market' : 'Back home';

  // Market-sync capabilities. These fields only exist once migration 0017 is
  // live; every fallback preserves the pre-sync behavior.
  const isMarket = Boolean(preview.is_market);
  const canEdit = preview.can_edit ?? true;
  const isLinked = !isMarket && preview.base_deck_id != null && Boolean(preview.base_deck_available);
  const updatesAvailable = preview.updates_available ?? 0;
  const outgoingChanges = preview.outgoing_changes ?? 0;
  const isClaimable = isMarket && preview.owner_id === null;

  const totalCards = preview.cards.length;
  const hiddenCount = preview.cards.filter((card) => !card.is_enabled).length;
  const isFiltered = Boolean(normalizedQuery) || statusFilter !== 'all';

  const detailsCard = detailsModalState
    ? preview.cards.find((card) => card.card_id === detailsModalState.cardId) ?? null
    : null;

  function handleSort(key) {
    setSort((current) => {
      if (current.key !== key) return { key, dir: 1 };
      if (current.dir === 1) return { key, dir: -1 };
      return { key: null, dir: 1 };
    });
  }

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

  async function handleClaimDeck() {
    setActionError('');
    setIsClaimPending(true);

    try {
      await claimMarketDeck(preview.deck_id);
      setPreviewRefreshToken((token) => token + 1);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setIsClaimPending(false);
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
        <Link className="back-link back-link--home back-link--button" to={backPath}>
          {from === 'market' ? <BackIcon /> : <HomeIcon />}
          <span>{backLabel}</span>
        </Link>
        <div className="deck-preview-page__toolbar-actions">
          {isLinked ? (
            <Link
              className="button button--secondary"
              to={`/decks/${preview.base_deck_id}/words`}
              state={{ from: 'market' }}
            >
              View market version
            </Link>
          ) : null}
          {isLinked ? (
            <button
              className={`button button--secondary ${updatesAvailable > 0 ? 'deck-preview__sync-button--pending' : ''}`}
              type="button"
              onClick={() => setActiveSyncModal('sync')}
            >
              Market updates{updatesAvailable > 0 ? ` (${updatesAvailable})` : ''}
            </button>
          ) : null}
          {isLinked && outgoingChanges > 0 ? (
            <button className="button button--secondary" type="button" onClick={() => setActiveSyncModal('propose')}>
              Propose to market ({outgoingChanges})
            </button>
          ) : null}
          {isMarket && preview.is_owner ? (
            <Link className="button button--secondary" to="/market/proposals">
              Proposals{(preview.open_proposals ?? 0) > 0 ? ` (${preview.open_proposals})` : ''}
            </Link>
          ) : null}
          {isClaimable ? (
            <button
              className="button button--secondary"
              type="button"
              disabled={isClaimPending}
              onClick={handleClaimDeck}
            >
              {isClaimPending ? 'Claiming…' : 'Become maintainer'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="deck-preview__header">
        <p className="eyebrow">Deck explorer</p>
        <div className="deck-preview__title-row">
          <h2>{preview.deck_title}</h2>
          <span className={`deck-scope-chip ${isMarket ? 'deck-scope-chip--market' : 'deck-scope-chip--personal'}`}>
            {isMarket ? 'Public · Market deck' : isLinked ? 'Personal copy' : 'Personal deck'}
          </span>
          {!canEdit ? <span className="deck-scope-chip deck-scope-chip--readonly">Read-only</span> : null}
        </div>
        <p className="deck-preview__description">{preview.deck_description}</p>
        {isMarket && preview.owner_id !== undefined ? (
          <p className="deck-preview__maintainer">
            {preview.is_owner
              ? 'You maintain this public market deck — edits here publish to every subscriber.'
              : preview.owner_id
                ? (<>Public deck maintained by <strong>{preview.owner_name}</strong>{canEdit ? '' : ' — browse it here, or add it to your home from the market to edit your own copy.'}</>)
                : 'Community deck · no maintainer yet'}
          </p>
        ) : null}
        {!isMarket ? (
          <p className="deck-preview__maintainer">
            {isLinked
              ? 'Your private copy of a market deck — edits stay in your account until you propose them to the market.'
              : 'Your private deck — edits here only affect you.'}
          </p>
        ) : null}
      </div>

      {actionError ? <p className="deck-preview__status deck-preview__status--error">{actionError}</p> : null}

      {totalCards ? (
        <>
          <div className="deck-table-controls">
            <label className="h-deck-search deck-table-controls__search" aria-label="Search cards in this deck">
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search words, translations, examples…"
              />
              {searchQuery ? (
                <button
                  className="deck-table-controls__clear"
                  type="button"
                  aria-label="Clear search"
                  title="Clear search"
                  onClick={() => setSearchQuery('')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </label>

            <div className="h-seg deck-table-controls__filter" role="group" aria-label="Filter cards by visibility">
              {STATUS_FILTERS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`h-seg__btn${statusFilter === value ? ' h-seg__btn--active' : ''}`}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>

            <p className="deck-table-controls__count" role="status">
              {isFiltered ? `${tableRows.length} of ${totalCards} cards` : `${totalCards} card${totalCards === 1 ? '' : 's'}`}
              {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
            </p>
          </div>

          <div className="deck-table-shell">
            {tableRows.length ? (
              <div className="deck-table-scroll" ref={tableScrollRef}>
                <table className="deck-table">
                  <thead>
                    <tr>
                      <SortableHeader label="Spanish" sortKey="word" sort={sort} onSort={handleSort} className="deck-table__col--word" />
                      <SortableHeader label="English" sortKey="translation" sort={sort} onSort={handleSort} className="deck-table__col--translation" />
                      <SortableHeader label="Section" sortKey="section" sort={sort} onSort={handleSort} className="deck-table__col--section" />
                      <th className="deck-table__col--pos">Part of speech</th>
                      <th className="deck-table__col--actions">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(({ card, matchedIn }) => (
                      <DeckWordRow
                        key={card.card_id}
                        card={card}
                        canEdit={canEdit}
                        isPending={pendingCardIds.includes(card.card_id)}
                        matchedIn={matchedIn}
                        highlightQuery={normalizedQuery}
                        onEdit={() => setDetailsModalState({ cardId: card.card_id, startInEditMode: true })}
                        onOpenDetails={() => setDetailsModalState({ cardId: card.card_id, startInEditMode: false })}
                        onToggle={() => handleToggleCard(card.card_id, !card.is_enabled)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="deck-table-empty">
                <p>
                  {normalizedQuery
                    ? <>No cards match <strong>“{searchQuery.trim()}”</strong>{statusFilter !== 'all' ? ` among ${statusFilter} cards` : ''}.</>
                    : `This deck has no ${statusFilter} cards.`}
                </p>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
                >
                  Clear search & filters
                </button>
              </div>
            )}
          </div>
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
          onSave={canEdit ? (values) => handleSaveCard(detailsCard.card_id, values) : undefined}
          onToggle={canEdit ? () => handleToggleCard(detailsCard.card_id, !detailsCard.is_enabled) : undefined}
        />
      ) : null}

      {activeSyncModal === 'sync' ? (
        <DeckSyncModal
          deckId={preview.deck_id}
          onClose={() => setActiveSyncModal(null)}
          onApplied={() => setPreviewRefreshToken((token) => token + 1)}
        />
      ) : null}

      {activeSyncModal === 'propose' ? (
        <ProposeChangesModal
          deckId={preview.deck_id}
          onClose={() => setActiveSyncModal(null)}
          onSubmitted={() => setPreviewRefreshToken((token) => token + 1)}
        />
      ) : null}
    </section>
  );
}

function DeckWordRow({ card, canEdit = true, isPending, matchedIn, highlightQuery, onToggle, onEdit, onOpenDetails }) {
  const toggleLabel = card.is_enabled ? `Hide card ${card.prompt_es}` : `Show card ${card.prompt_es}`;
  const toggleTitle = card.is_enabled ? 'Hide card from deck' : 'Show card in deck again';

  return (
    <tr
      className={`deck-table__row ${card.is_enabled ? '' : 'deck-table__row--disabled'}`}
      onClick={onOpenDetails}
    >
      <td className="deck-table__cell deck-table__cell--word">
        <strong><HighlightText text={card.prompt_es} query={highlightQuery} /></strong>
        {!card.is_enabled ? <span className="deck-table__state-chip">Hidden</span> : null}
        {matchedIn ? <span className="deck-table__match-chip">Matched in {matchedIn}</span> : null}
      </td>
      <td className="deck-table__cell deck-table__cell--translation">
        <HighlightText text={card.answer_en} query={highlightQuery} />
      </td>
      <td className="deck-table__cell deck-table__cell--section">
        {card.section_name
          ? <HighlightText text={card.section_name} query={highlightQuery} />
          : <span className="deck-table__placeholder">—</span>}
      </td>
      <td className="deck-table__cell deck-table__cell--pos">
        {card.part_of_speech || <span className="deck-table__placeholder">—</span>}
      </td>
      <td className="deck-table__cell deck-table__cell--actions">
        <div className="deck-table__actions">
          {canEdit ? (
            <button
              className="deck-preview__icon-button"
              type="button"
              aria-label={toggleLabel}
              title={toggleTitle}
              onClick={(event) => { event.stopPropagation(); onToggle(); }}
              disabled={isPending}
            >
              {card.is_enabled ? (
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                  <path d="M15.0007 12C15.0007 13.6569 13.6576 15 12.0007 15C10.3439 15 9.00073 13.6569 9.00073 12C9.00073 10.3431 10.3439 9 12.0007 9C13.6576 9 15.0007 10.3431 15.0007 12Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12.0012 5C7.52354 5 3.73326 7.94288 2.45898 12C3.73324 16.0571 7.52354 19 12.0012 19C16.4788 19 20.2691 16.0571 21.5434 12C20.2691 7.94291 16.4788 5 12.0012 5Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
                  <path d="M2.99902 3L20.999 21M9.8433 9.91364C9.32066 10.4536 8.99902 11.1892 8.99902 12C8.99902 13.6569 10.3422 15 11.999 15C12.8215 15 13.5667 14.669 14.1086 14.133M6.49902 6.64715C4.59972 7.90034 3.15305 9.78394 2.45703 12C3.73128 16.0571 7.52159 19 11.9992 19C13.9881 19 15.8414 18.4194 17.3988 17.4184M10.999 5.04939C11.328 5.01673 11.6617 5 11.9992 5C16.4769 5 20.2672 7.94291 21.5414 12C21.2607 12.894 20.8577 13.7338 20.3522 14.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ) : null}

          {canEdit ? (
            <button
              className="deck-preview__icon-button deck-preview__icon-button--muted"
              type="button"
              aria-label={`Edit card ${card.prompt_es}`}
              title="Edit card"
              onClick={(event) => { event.stopPropagation(); onEdit(); }}
              disabled={isPending}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M4 20h4.2L19 9.2a1.5 1.5 0 0 0 0-2.1l-2.1-2.1a1.5 1.5 0 0 0-2.1 0L4 15.8V20Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M13.5 6.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}

          <button
            className="deck-preview__icon-button deck-preview__icon-button--muted"
            type="button"
            aria-label={`Show details for ${card.prompt_es}`}
            title="Show card details"
            onClick={(event) => { event.stopPropagation(); onOpenDetails(); }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="5" cy="12" r="1.7" fill="currentColor" />
              <circle cx="12" cy="12" r="1.7" fill="currentColor" />
              <circle cx="19" cy="12" r="1.7" fill="currentColor" />
            </svg>
          </button>
        </div>
      </td>
    </tr>
  );
}

export default DeckWordsPage;
