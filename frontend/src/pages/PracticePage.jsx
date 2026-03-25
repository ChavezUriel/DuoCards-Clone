import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { startSmartPracticeSession, submitSmartPracticeReview, updateCard } from '../api';
import CardDetailsModal from '../components/CardDetailsModal';
import Flashcard from '../components/Flashcard';
import { loadPracticeSettings } from '../practiceSettings';

const FIRST_IDLE_HINT_DELAY_MS = 10000;
const REPEATED_IDLE_HINT_DELAY_MS = 20000;

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="back-link__icon" viewBox="0 0 24 24">
      <path d="M4 10.5 12 4l8 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 9.75V20h11V9.75" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20v-5.25h4V20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function modeLabel(mode) {
  return mode === 'new_material' ? 'New Material' : 'Review Stack';
}

function PracticePage() {
  const [session, setSession] = useState(null);
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const [isSavingCard, setIsSavingCard] = useState(false);
  const [isIdleHintVisible, setIsIdleHintVisible] = useState(false);
  const idleHintTimeoutRef = useRef(null);
  const hasShownIdleHintRef = useRef(false);

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

    const delay = hasShownIdleHintRef.current ? REPEATED_IDLE_HINT_DELAY_MS : FIRST_IDLE_HINT_DELAY_MS;
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

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (status !== 'ready' || !session?.current_card || isSubmitting) {
        return;
      }

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        setIsAnswerVisible(true);
        return;
      }

      if (!isAnswerVisible) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleReview('unknown');
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleReview('known');
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isAnswerVisible, isSubmitting, session, status]);

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [isAnswerVisible, session?.current_card?.card_id]);

  useEffect(() => {
    if (status !== 'ready' || !session?.current_card || isSubmitting || isDetailsVisible) {
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
  }, [isAnswerVisible, isDetailsVisible, isSubmitting, session?.current_card?.card_id, status]);

  async function handleReview(result) {
    if (!session?.current_card) {
      return;
    }

    try {
      setIsSubmitting(true);
      const response = await submitSmartPracticeReview(session.summary.session_id, session.current_card.card_id, result);
      setSession(response.session);
      setIsAnswerVisible(false);
    } catch (submitError) {
      setError(submitError.message);
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
          <Link className="back-link back-link--home" to="/">
            <HomeIcon />
            <span>Home</span>
          </Link>

          <div className="practice-session-summary" aria-label="Smart practice summary">
            <span className="practice-session-summary__mode">{modeLabel(summary.mode)}</span>
            <div className="practice-session-summary__stats">
              <span>{summary.completed_cards} done</span>
              <span>{summary.remaining_cards} left</span>
              <span>{summary.interleaving_intensity}</span>
            </div>
          </div>
        </div>

        {session.current_card ? (
          <Flashcard
            card={session.current_card}
            isAnswerVisible={isAnswerVisible}
            isSubmitting={isSubmitting}
            hideRevealButton
            hideRevealButtonOnMobile
            isIdleHintVisible={isIdleHintVisible}
            onReveal={() => setIsAnswerVisible(true)}
            onToggleReveal={() => setIsAnswerVisible((current) => !current)}
            onOpenDetails={() => setIsDetailsVisible(true)}
            onReviewKnown={() => handleReview('known')}
            onReviewUnknown={() => handleReview('unknown')}
          />
        ) : (
          <section className="panel empty-state practice-complete">
            <p className="eyebrow">Session complete</p>
            <h2>You cleared this smart practice round.</h2>
            <p>
              Completed {summary.completed_cards} of {summary.total_cards} cards in {modeLabel(summary.mode).toLowerCase()} mode.
            </p>
            <Link className="button button--primary" to="/">
              Start another session
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