import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchDeckProgress, fetchReviewCard, submitReview, updateCard } from '../api';
import CardDetailsModal from '../components/CardDetailsModal';
import Flashcard from '../components/Flashcard';
import ProgressSummary from '../components/ProgressSummary';

function ReviewPage() {
  const { deckId } = useParams();
  const [card, setCard] = useState(null);
  const [progress, setProgress] = useState(null);
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const [isSavingCard, setIsSavingCard] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadScreen() {
      try {
        setStatus('loading');
        const [nextCard, nextProgress] = await Promise.all([
          fetchReviewCard(deckId),
          fetchDeckProgress(deckId),
        ]);
        if (!cancelled) {
          setCard(nextCard);
          setProgress(nextProgress);
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

    loadScreen();

    return () => {
      cancelled = true;
    };
  }, [deckId]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (status !== 'ready' || !card || isSubmitting) {
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
  }, [card, isAnswerVisible, isSubmitting, status]);

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [card?.card_id, isAnswerVisible]);

  async function handleReview(result) {
    if (!card) {
      return;
    }

    try {
      setIsSubmitting(true);
      await submitReview(card.card_id, result);
      const [nextCard, nextProgress] = await Promise.all([
        fetchReviewCard(deckId),
        fetchDeckProgress(deckId),
      ]);
      setCard(nextCard);
      setProgress(nextProgress);
      setIsAnswerVisible(false);
    } catch (submitError) {
      setError(submitError.message);
      setStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveCard(values) {
    if (!card) {
      return null;
    }

    setIsSavingCard(true);
    setError('');

    try {
      const updatedCard = await updateCard(card.card_id, values);
      setCard((current) => (current?.card_id === updatedCard.card_id ? { ...current, ...updatedCard } : current));
      return updatedCard;
    } catch (saveError) {
      setError(saveError.message);
      return null;
    } finally {
      setIsSavingCard(false);
    }
  }

  if (status === 'loading') {
    return <section className="panel empty-state">Preparing your next card...</section>;
  }

  if (status === 'error') {
    return (
      <section className="panel empty-state">
        <p>There was a problem loading the review session.</p>
        <p>{error}</p>
        <Link className="button button--secondary" to="/">
          Back to home
        </Link>
      </section>
    );
  }

  return (
    <section className="review-screen">
      {progress ? <ProgressSummary progress={progress} /> : null}

      <div className="review-stage">
        <Link className="back-link" to="/">
          Back to home
        </Link>

        <Flashcard
          card={card}
          isAnswerVisible={isAnswerVisible}
          onReveal={() => setIsAnswerVisible((current) => !current)}
          onToggleReveal={() => setIsAnswerVisible((current) => !current)}
          onOpenDetails={() => setIsDetailsVisible(true)}
        />

        <div className="review-actions">
          <p className="review-shortcuts">Up or down reveals. Left reviews again. Right marks known.</p>
          <div className="action-row">
            <button
              className="button button--danger"
              type="button"
              onClick={() => handleReview('unknown')}
              disabled={!isAnswerVisible || isSubmitting}
            >
              I need to review it
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

        {card && isDetailsVisible ? (
          <CardDetailsModal
            card={card}
            isPending={isSavingCard}
            onClose={() => setIsDetailsVisible(false)}
            onSave={handleSaveCard}
          />
        ) : null}
      </div>

    </section>
  );
}

export default ReviewPage;
