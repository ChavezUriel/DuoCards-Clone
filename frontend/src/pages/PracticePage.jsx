import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { startSmartPracticeSession, submitSmartPracticeReview } from '../api';
import Flashcard from '../components/Flashcard';
import { loadPracticeSettings } from '../practiceSettings';

function modeLabel(mode) {
  return mode === 'new_material' ? 'New Material' : 'Review Stack';
}

function PracticePage() {
  const [session, setSession] = useState(null);
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  if (status === 'loading') {
    return <section className="panel empty-state">Preparing your smart practice session...</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>There was a problem loading smart practice.</p>
        <p>{error}</p>
        <Link className="button button--secondary" to="/">
          Back to home
        </Link>
      </section>
    );
  }

  const summary = session.summary;

  return (
    <section className="review-screen">
      <div className="review-stage">
        <div className="practice-session-bar">
          <Link className="back-link" to="/">
            Back to home
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
            onReveal={() => setIsAnswerVisible((current) => !current)}
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

        {session.current_card ? (
          <div className="review-actions">
            <p className="review-shortcuts">Up or down reveals. Left reviews again. Right marks known.</p>
            <div className="action-row">
              <button
                className="button button--danger"
                type="button"
                onClick={() => handleReview('unknown')}
                disabled={!isAnswerVisible || isSubmitting}
              >
                Needs another pass
              </button>
              <button
                className="button button--primary"
                type="button"
                onClick={() => handleReview('known')}
                disabled={!isAnswerVisible || isSubmitting}
              >
                I knew it
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default PracticePage;