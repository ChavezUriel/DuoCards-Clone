import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchDeckPreview, updateCard, updateCardVisibility } from '../api';

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
      return true;
    } catch (requestError) {
      setActionError(requestError.message);
      return false;
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
        <DeckWordDetailsModal
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
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M1.5 12s3.9-6.5 10.5-6.5S22.5 12 22.5 12s-3.9 6.5-10.5 6.5S1.5 12 1.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M2.5 12s3.3-5.8 9.5-5.8c2.3 0 4.2.8 5.8 1.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M21.5 12s-3.3 5.8-9.5 5.8c-2.3 0-4.2-.8-5.8-1.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9.9 9.9A3.2 3.2 0 0 1 15 14.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 3l18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
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

function DeckWordDetailsModal({ card, isPending, startInEditMode = false, onClose, onSave, onToggle }) {
  const toggleLabel = card.is_enabled ? 'Hide card' : 'Show card';
  const [isEditing, setIsEditing] = useState(startInEditMode);
  const [saveError, setSaveError] = useState('');
  const [formValues, setFormValues] = useState(() => buildFormValues(card));

  useEffect(() => {
    setIsEditing(startInEditMode);
    setSaveError('');
    setFormValues(buildFormValues(card));
  }, [card.card_id, startInEditMode]);

  function updateField(name, value) {
    setFormValues((current) => ({ ...current, [name]: value }));
  }

  async function handleSave() {
    setSaveError('');

    const wasSaved = await onSave({
      prompt_es: formValues.prompt_es.trim(),
      answer_en: formValues.answer_en.trim(),
      section_name: nullableText(formValues.section_name),
      part_of_speech: nullableText(formValues.part_of_speech),
      definition_en: nullableText(formValues.definition_en),
      main_translations_es: splitMultiline(formValues.main_translations_es),
      collocations: splitMultiline(formValues.collocations),
      example_sentence: nullableText(formValues.example_sentence),
      example_es: nullableText(formValues.example_es),
      example_en: nullableText(formValues.example_en),
    });

    if (wasSaved) {
      setIsEditing(false);
      return;
    }

    setSaveError('Unable to save changes.');
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setSaveError('');
    setFormValues(buildFormValues(card));
  }

  return (
    <div className="details-modal" role="dialog" aria-modal="true" aria-label="Flashcard metadata">
      <button
        aria-label="Close flashcard metadata"
        className="details-modal__backdrop"
        type="button"
        onClick={onClose}
      />
      <div className="details-modal__panel">
        <button
          aria-label="Close flashcard metadata"
          className="details-modal__close"
          type="button"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>

        <div className="details-modal__header">
          <p className="flashcard__label">Flashcard metadata</p>
          <h3>{isEditing ? formValues.answer_en || 'Flashcard' : card.answer_en}</h3>
        </div>

        <div className="flashcard-details">
          <div>
            <span>Spanish prompt</span>
            {isEditing ? (
              <input value={formValues.prompt_es} onChange={(event) => updateField('prompt_es', event.target.value)} />
            ) : (
              <p>{card.prompt_es}</p>
            )}
          </div>

          <div>
            <span>English answer</span>
            {isEditing ? (
              <input value={formValues.answer_en} onChange={(event) => updateField('answer_en', event.target.value)} />
            ) : (
              <p>{card.answer_en}</p>
            )}
          </div>

          <div>
            <span>Section</span>
            {isEditing ? (
              <input value={formValues.section_name} onChange={(event) => updateField('section_name', event.target.value)} />
            ) : (
              <p>{card.section_name || 'Unassigned'}</p>
            )}
          </div>

          <div>
            <span>Part of speech</span>
            {isEditing ? (
              <input value={formValues.part_of_speech} onChange={(event) => updateField('part_of_speech', event.target.value)} />
            ) : (
              <p>{card.part_of_speech || 'Not set'}</p>
            )}
          </div>

          <div>
            <span>Definition in English</span>
            {isEditing ? (
              <textarea value={formValues.definition_en} onChange={(event) => updateField('definition_en', event.target.value)} rows={3} />
            ) : (
              <p>{card.definition_en || 'Not set'}</p>
            )}
          </div>

          <div>
            <span>Main translations</span>
            {isEditing ? (
              <textarea value={formValues.main_translations_es} onChange={(event) => updateField('main_translations_es', event.target.value)} rows={3} />
            ) : card.main_translations_es?.length ? (
              <ul>
                {card.main_translations_es.map((translation) => (
                  <li key={translation}>{translation}</li>
                ))}
              </ul>
            ) : (
              <p>Not set</p>
            )}
          </div>

          <div>
            <span>Collocations</span>
            {isEditing ? (
              <textarea value={formValues.collocations} onChange={(event) => updateField('collocations', event.target.value)} rows={3} />
            ) : card.collocations?.length ? (
              <ul>
                {card.collocations.map((collocation) => (
                  <li key={collocation}>{collocation}</li>
                ))}
              </ul>
            ) : (
              <p>Not set</p>
            )}
          </div>

          <div>
            <span>Example sentence</span>
            {isEditing ? (
              <textarea value={formValues.example_sentence} onChange={(event) => updateField('example_sentence', event.target.value)} rows={3} />
            ) : (
              <p>{card.example_sentence || 'Not set'}</p>
            )}
          </div>

          <div>
            <span>Example in Spanish</span>
            {isEditing ? (
              <textarea value={formValues.example_es} onChange={(event) => updateField('example_es', event.target.value)} rows={2} />
            ) : (
              <p>{card.example_es || 'Not set'}</p>
            )}
          </div>

          <div>
            <span>Example in English</span>
            {isEditing ? (
              <textarea value={formValues.example_en} onChange={(event) => updateField('example_en', event.target.value)} rows={2} />
            ) : (
              <p>{card.example_en || 'Not set'}</p>
            )}
          </div>
        </div>

        {saveError ? <p className="details-modal__status details-modal__status--error">{saveError}</p> : null}

        <div className="details-modal__actions">
          {isEditing ? (
            <button className="button button--primary" type="button" onClick={handleSave} disabled={isPending}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M5 12.5 9.2 16.7 19 7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Save</span>
            </button>
          ) : (
            <span />
          )}

          <div className="details-modal__actions-group">
            <button className="button button--secondary" type="button" onClick={onToggle} disabled={isPending}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                {card.is_enabled ? (
                  <>
                    <path d="M1.5 12s3.9-6.5 10.5-6.5S22.5 12 22.5 12s-3.9 6.5-10.5 6.5S1.5 12 1.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="12" cy="12" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
                  </>
                ) : (
                  <>
                    <path d="M2.5 12s3.3-5.8 9.5-5.8c2.3 0 4.2.8 5.8 1.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M21.5 12s-3.3 5.8-9.5 5.8c-2.3 0-4.2-.8-5.8-1.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M9.9 9.9A3.2 3.2 0 0 1 15 14.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M3 3l18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </>
                )}
              </svg>
              <span>{toggleLabel}</span>
            </button>

            <button className="button button--secondary" type="button" onClick={isEditing ? handleCancelEdit : () => setIsEditing(true)} disabled={isPending}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                {isEditing ? (
                  <>
                    <path d="M7 7 17 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                    <path d="M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  </>
                ) : (
                  <>
                    <path d="M4 20h4.2L19 9.2a1.5 1.5 0 0 0 0-2.1l-2.1-2.1a1.5 1.5 0 0 0-2.1 0L4 15.8V20Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M13.5 6.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </>
                )}
              </svg>
              <span>{isEditing ? 'Cancel' : 'Edit'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildFormValues(card) {
  return {
    prompt_es: card.prompt_es ?? '',
    answer_en: card.answer_en ?? '',
    section_name: card.section_name ?? '',
    part_of_speech: card.part_of_speech ?? '',
    definition_en: card.definition_en ?? '',
    main_translations_es: (card.main_translations_es ?? []).join('\n'),
    collocations: (card.collocations ?? []).join('\n'),
    example_sentence: card.example_sentence ?? '',
    example_es: card.example_es ?? '',
    example_en: card.example_en ?? '',
  };
}

function splitMultiline(value) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function nullableText(value) {
  const normalized = value.trim();
  return normalized || null;
}

export default DeckWordsPage;