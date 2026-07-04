import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMinigameDistractors,
  skipSmartPracticeCard,
  startSmartPracticeSession,
  submitSmartPracticeReview,
  undoSmartPracticeReview,
  updateCard,
} from '../api';
import CardDetailsModal from '../components/CardDetailsModal';
import MinigameHost, { resolveModality, selectModality } from '../components/MinigameHost';
import { loadPracticeSettings } from '../practiceSettings';

const FIRST_IDLE_HINT_DELAY_MS = 10000;

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M4 10.5 12 4l8 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 9.75V20h11V9.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20v-5.25h4V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M9 5 4 10l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 10h9a6 6 0 0 1 6 6v2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function modeLabel(mode) {
  if (mode === 'new_material') return 'New Material';
  if (mode === 'mixed') return 'Mixed Practice';
  return 'Review Stack';
}

function feedbackMessage(feedback) {
  if (!feedback) {
    return '';
  }

  if (feedback.repeats_in_session) {
    return feedback.result === 'known' ? 'Almost there — one more pass this session.' : 'No problem — it comes back this session.';
  }

  const days = feedback.interval_days;
  if (!days || days < 1) {
    return 'Scheduled for review soon.';
  }
  if (days === 1) {
    return 'Next review tomorrow.';
  }
  if (days >= 60) {
    return `Locked in — next review in ${Math.round(days / 30)} months.`;
  }
  return `Next review in ${days} days.`;
}

function PracticePage() {
  const [session, setSession] = useState(null);
  // Read once at mount, same as the session start below; MinigameHost uses these
  // to decide each card's answer modality (Phase 0: always the classic flashcard).
  const [practiceSettings] = useState(() => loadPracticeSettings());
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const [isSavingCard, setIsSavingCard] = useState(false);
  const [isIdleHintVisible, setIsIdleHintVisible] = useState(false);
  const [reviewFeedback, setReviewFeedback] = useState(null);
  const idleHintTimeoutRef = useRef(null);
  const hasShownIdleHintRef = useRef(false);
  const feedbackTimeoutRef = useRef(null);
  const flashcardActionsRef = useRef(null);
  // Per-session cache of minigame distractors, keyed by card_id. Cards cycle
  // through the queue repeatedly, so caching a card's distractors on first fetch
  // makes every later presentation instant (docs/minigames.md §8.3, §12 latency).
  // The counter just forces a re-render when an async fetch settles.
  const distractorCacheRef = useRef(new Map());
  const [, setDistractorVersion] = useState(0);

  useEffect(() => () => {
    if (feedbackTimeoutRef.current) {
      window.clearTimeout(feedbackTimeoutRef.current);
    }
  }, []);

  // The classic flashcard is the only arrow-driven modality. Other modalities
  // (typing, multiple choice) own their own input and keyboard handling, so the
  // global reveal/swipe shortcuts and the idle swipe hint stay inert for them.
  // Reads through the distractor cache (distractorVersion re-triggers this on
  // fetch), so a multiple-choice card that falls back to classic for want of
  // distractors correctly re-enables the arrow handlers. See docs/minigames.md §8.4.
  const currentCard = session?.current_card ?? null;
  const currentDistractorEntry = currentCard
    ? distractorCacheRef.current.get(currentCard.card_id)
    : undefined;
  const currentModality = currentCard
    ? resolveModality(currentCard, practiceSettings, currentDistractorEntry)
    : 'classic';
  const isClassicModality = currentModality === 'classic';

  function clearIdleHintTimer() {
    if (idleHintTimeoutRef.current) {
      window.clearTimeout(idleHintTimeoutRef.current);
      idleHintTimeoutRef.current = null;
    }
  }

  function scheduleIdleHint() {
    clearIdleHintTimer();

    if (typeof window === 'undefined') {
      return;
    }

    const delay = FIRST_IDLE_HINT_DELAY_MS;
    idleHintTimeoutRef.current = window.setTimeout(() => {
      setIsIdleHintVisible(true);
      hasShownIdleHintRef.current = true;
      idleHintTimeoutRef.current = null;
    }, delay);
  }

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const nextSession = await startSmartPracticeSession(loadPracticeSettings());
        if (!cancelled) {
          setSession(nextSession);
          setIsAnswerVisible(false);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setStatus('error');
        }
      }
    }

    loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the current card's multiple-choice distractors as soon as it arrives,
  // so the tiles are ready by the time the learner has read the prompt. Results
  // are cached per session (see distractorCacheRef), so a re-queued card reuses
  // them instantly. Only fires when the card is provisionally MC-eligible; a
  // failed/empty fetch is cached too, and resolveModality then falls back to
  // classic. See docs/minigames.md §8.3.
  useEffect(() => {
    const card = session?.current_card;
    if (!card || selectModality(card, practiceSettings) !== 'multiple_choice') {
      return;
    }

    const cache = distractorCacheRef.current;
    if (cache.has(card.card_id)) {
      return;
    }

    cache.set(card.card_id, { status: 'loading', distractors: [] });
    setDistractorVersion((version) => version + 1);

    getMinigameDistractors(card.card_id, 3)
      .then((list) => {
        cache.set(card.card_id, { status: 'ready', distractors: Array.isArray(list) ? list : [] });
      })
      .catch(() => {
        cache.set(card.card_id, { status: 'error', distractors: [] });
      })
      .finally(() => setDistractorVersion((version) => version + 1));
  }, [session?.current_card?.card_id, practiceSettings]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (status !== 'ready' || !session?.current_card || isSubmitting || isDetailsVisible) {
        return;
      }

      // Non-classic modalities drive themselves (e.g. the typing input owns Enter),
      // so the classic reveal/swipe shortcuts must not fire for them.
      if (!isClassicModality) {
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIsAnswerVisible((current) => !current);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIsAnswerVisible(true);
        return;
      }

      if (!isAnswerVisible) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        flashcardActionsRef.current?.triggerReview('left');
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        flashcardActionsRef.current?.triggerReview('right');
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAnswerVisible, isClassicModality, isDetailsVisible, isSubmitting, session, status]);

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [isAnswerVisible, session?.current_card?.card_id]);

  useEffect(() => {
    // The idle hint only teaches the classic tap-to-reveal / swipe gestures, so
    // skip it entirely for other modalities (also avoids re-rendering on every
    // keystroke into the typing input).
    if (status !== 'ready' || !session?.current_card || isSubmitting || isDetailsVisible || !isClassicModality) {
      setIsIdleHintVisible(false);
      clearIdleHintTimer();
      return undefined;
    }

    setIsIdleHintVisible(false);
    scheduleIdleHint();

    function handleInteraction() {
      setIsIdleHintVisible(false);
      scheduleIdleHint();
    }

    window.addEventListener('pointerdown', handleInteraction, true);
    window.addEventListener('keydown', handleInteraction, true);

    return () => {
      clearIdleHintTimer();
      window.removeEventListener('pointerdown', handleInteraction, true);
      window.removeEventListener('keydown', handleInteraction, true);
    };
  }, [isAnswerVisible, isClassicModality, isDetailsVisible, isSubmitting, session?.current_card?.card_id, status]);

  // Unified resolution for every answer modality (docs/minigames.md §5, §8.2):
  //   * skip (a Tier-B recognition win) -> advance WITHOUT grading via the skip RPC.
  //   * counted result -> the graded path (classic swipe, Tier-A typing).
  //   * anything else (non-counting practice outcome) -> resolve locally, no RPC.
  async function resolveCard({ result, counts = false, skip = false }) {
    if (!session?.current_card) {
      return;
    }

    if (skip) {
      try {
        setIsSubmitting(true);
        // Returns a bare session snapshot (not { session, review_feedback }), so
        // set it directly. No FSRS change, so there is no scheduling feedback to show.
        const response = await skipSmartPracticeCard(session.summary.session_id, session.current_card.card_id);
        setSession(response);
        setIsAnswerVisible(false);
      } catch (skipError) {
        setError(skipError.message);
        setStatus('error');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!counts || !result) {
      return;
    }

    try {
      setIsSubmitting(true);
      const response = await submitSmartPracticeReview(session.summary.session_id, session.current_card.card_id, result);
      setSession(response.session);
      setIsAnswerVisible(false);

      if (response.review_feedback) {
        setReviewFeedback(response.review_feedback);
        if (feedbackTimeoutRef.current) {
          window.clearTimeout(feedbackTimeoutRef.current);
        }
        feedbackTimeoutRef.current = window.setTimeout(() => {
          setReviewFeedback(null);
          feedbackTimeoutRef.current = null;
        }, 2200);
      }
    } catch (submitError) {
      setError(submitError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUndo() {
    if (!session?.summary?.can_undo || isSubmitting) {
      return;
    }

    try {
      setIsSubmitting(true);
      const nextSession = await undoSmartPracticeReview(session.summary.session_id);
      setSession(nextSession);
      // Bring the card back with its answer showing so the correction is one swipe away.
      setIsAnswerVisible(true);
      if (feedbackTimeoutRef.current) {
        window.clearTimeout(feedbackTimeoutRef.current);
        feedbackTimeoutRef.current = null;
      }
      setReviewFeedback(null);
    } catch (undoError) {
      setError(undoError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveCard(values) {
    if (!session?.current_card) {
      return null;
    }

    setIsSavingCard(true);
    setError('');

    try {
      const updatedCard = await updateCard(session.current_card.card_id, values);
      setSession((current) => {
        if (!current?.current_card || current.current_card.card_id !== updatedCard.card_id) {
          return current;
        }

        return {
          ...current,
          current_card: {
            ...current.current_card,
            ...updatedCard,
          },
        };
      });
      return updatedCard;
    } catch (saveError) {
      setError(saveError.message);
      return null;
    } finally {
      setIsSavingCard(false);
    }
  }

  if (status === 'loading') {
    return <section className="panel empty-state">Preparing your smart practice session...</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>There was a problem loading smart practice.</p>
        <p>{error}</p>
        <Link className="back-link back-link--home back-link--button" to="/">
          <HomeIcon />
          <span>Home</span>
        </Link>
      </section>
    );
  }

  const summary = session.summary;

  return (
    <section className="review-screen">
      <div className="review-stage">
        <div className="practice-session-bar">
          <div className="practice-session-bar__nav">
            <Link className="back-link back-link--home" to="/">
              <HomeIcon />
              <span>Home</span>
            </Link>

            {summary.can_undo ? (
              <button
                type="button"
                className="back-link back-link--home review-undo-button"
                onClick={handleUndo}
                disabled={isSubmitting}
              >
                <UndoIcon />
                <span>Undo</span>
              </button>
            ) : null}
          </div>

          <div className="practice-session-summary" aria-label="Smart practice summary">
            <span className="practice-session-summary__mode">{modeLabel(summary.mode)}</span>
            <div className="practice-session-summary__stats">
              <span>{summary.completed_cards} done</span>
              {summary.mode === 'mixed' ? (
                <>
                  <span>{summary.remaining_new} new</span>
                  <span>{summary.remaining_review} review</span>
                </>
              ) : (
                <span>{summary.remaining_cards} left</span>
              )}
              <span>{summary.interleaving_intensity}</span>
            </div>
          </div>
        </div>

        {reviewFeedback ? (
          <div
            className={`practice-feedback-toast practice-feedback-toast--${reviewFeedback.result}`}
            role="status"
            aria-live="polite"
          >
            {feedbackMessage(reviewFeedback)}
          </div>
        ) : null}

        {session.current_card ? (
          <MinigameHost
            card={session.current_card}
            settings={practiceSettings}
            onResolve={resolveCard}
            distractorEntry={currentDistractorEntry}
            isAnswerVisible={isAnswerVisible}
            isSubmitting={isSubmitting}
            isIdleHintVisible={isIdleHintVisible}
            actionsRef={flashcardActionsRef}
            onReveal={() => setIsAnswerVisible(true)}
            onToggleReveal={() => setIsAnswerVisible((current) => !current)}
            onOpenDetails={() => setIsDetailsVisible(true)}
          />
        ) : (
          <section className="panel empty-state practice-complete">
            <p className="eyebrow">Session complete</p>
            <h2>You cleared this smart practice round.</h2>
            <p>
              Completed {summary.completed_cards} of {summary.total_cards} cards in {modeLabel(summary.mode).toLowerCase()} mode.
            </p>
            <Link className="button button--primary" to="/">
              Back to home
            </Link>
          </section>
        )}

        {session.current_card && isDetailsVisible ? (
          <CardDetailsModal
            card={session.current_card}
            isPending={isSavingCard}
            onClose={() => setIsDetailsVisible(false)}
            onSave={handleSaveCard}
          />
        ) : null}
      </div>
    </section>
  );
}

export default PracticePage;