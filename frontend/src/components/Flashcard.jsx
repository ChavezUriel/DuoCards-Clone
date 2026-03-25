import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const AUTO_SPEECH_DEDUPE_WINDOW_MS = 750;
const TAP_REVEAL_TOLERANCE_PX = 10;
const SWIPE_REVIEW_THRESHOLD_PX = 72;
const HORIZONTAL_SWIPE_RATIO = 1.2;
let lastAutoSpeech = {
  key: '',
  at: 0,
};

function canUseSpeechSynthesis() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function normalizeSpeechText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, label'));
}

function useTwoLineFit(targetRef, dependencies) {
  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const element = targetRef.current;
    if (!element) {
      return undefined;
    }

    let animationFrameId = 0;

    function countRenderedLines() {
      const computedStyles = window.getComputedStyle(element);
      const lineHeight = parseFloat(computedStyles.lineHeight);

      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        return 1;
      }

      return element.scrollHeight / lineHeight;
    }

    function fitToTwoLines() {
      element.style.removeProperty('--flashcard-fit-font-size');

      const computedStyles = window.getComputedStyle(element);
      const baseFontSize = parseFloat(computedStyles.fontSize);

      if (!Number.isFinite(baseFontSize) || baseFontSize <= 0) {
        return;
      }

      const minimumFontSize = Math.max(baseFontSize * 0.38, 18);
      let nextFontSize = baseFontSize;

      while (countRenderedLines() > 2.05 && nextFontSize > minimumFontSize) {
        nextFontSize = Math.max(nextFontSize - 1, minimumFontSize);
        element.style.setProperty('--flashcard-fit-font-size', `${nextFontSize}px`);
      }

      if (nextFontSize >= baseFontSize - 0.5) {
        element.style.removeProperty('--flashcard-fit-font-size');
      }
    }

    function scheduleFit() {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = window.requestAnimationFrame(fitToTwoLines);
    }

    scheduleFit();

    const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(scheduleFit) : null;
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }

    window.addEventListener('resize', scheduleFit);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleFit);
      element.style.removeProperty('--flashcard-fit-font-size');
    };
  }, dependencies);
}

function AudioIcon() {
  return (
    <svg aria-hidden="true" className="flashcard__audio-icon" viewBox="0 0 24 24">
      <path d="M3.75 9.5h4.1l4.4-3.55a.75.75 0 0 1 1.22.6v10.9a.75.75 0 0 1-1.22.6L7.85 14.5h-4.1A1.25 1.25 0 0 1 2.5 13.25v-2.5A1.25 1.25 0 0 1 3.75 9.5Z" fill="currentColor" />
      <path d="M16.55 8.2a.75.75 0 0 1 1.06.08 5.63 5.63 0 0 1 0 7.44.75.75 0 1 1-1.14-.98 4.12 4.12 0 0 0 0-5.48.75.75 0 0 1 .08-1.06Z" fill="currentColor" />
      <path d="M18.97 5.74a.75.75 0 0 1 1.06.07 9.38 9.38 0 0 1 0 12.38.75.75 0 1 1-1.14-.97 7.88 7.88 0 0 0 0-10.44.75.75 0 0 1 .08-1.04Z" fill="currentColor" />
    </svg>
  );
}

function SwipeDirectionIcon({ direction }) {
  const isLeft = direction === 'left';

  return (
    <svg aria-hidden="true" className="flashcard__swipe-icon" viewBox="0 0 20 20">
      <path
        d={isLeft ? 'M11.5 4.5 6 10l5.5 5.5' : 'M8.5 4.5 14 10l-5.5 5.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={isLeft ? 'M14.25 10H6.5' : 'M5.75 10H13.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TapRevealIcon() {
  return (
    <svg aria-hidden="true" className="flashcard__tap-icon" viewBox="0 0 20 20">
      <path
        d="M10 2.75v4.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M7.2 4.3 8.8 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12.8 4.3 11.2 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M7.75 9.2V6.8a1 1 0 1 1 2 0v2.1-3a1 1 0 1 1 2 0v3.35-.95a1 1 0 1 1 2 0v1.65-.45a1 1 0 1 1 2 0v3.05c0 2.65-1.9 4.55-4.55 4.55h-1.4c-1.35 0-2.28-.6-3.15-1.85L5.5 11.9a1 1 0 0 1 1.6-1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Flashcard({
  card,
  isAnswerVisible,
  isSubmitting,
  hideRevealButton = false,
  hideRevealButtonOnMobile = false,
  isIdleHintVisible = false,
  onReveal,
  onToggleReveal,
  onOpenDetails,
  onReviewKnown,
  onReviewUnknown,
}) {
  const activeUtteranceRef = useRef(null);
  const previousAnswerVisibleRef = useRef(isAnswerVisible);
  const promptHeadingRef = useRef(null);
  const answerHeadingRef = useRef(null);
  const gestureStateRef = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    tracking: false,
  });
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const hasAnswerSpeech = canUseSpeechSynthesis() && Boolean(normalizeSpeechText(card.answer_en));
  const swipeFeedback =
    dragOffsetX >= SWIPE_REVIEW_THRESHOLD_PX ? 'known' : dragOffsetX <= -SWIPE_REVIEW_THRESHOLD_PX ? 'unknown' : '';
  const showRevealHint = isIdleHintVisible && !isAnswerVisible;
  const showSwipeHint = isIdleHintVisible && isAnswerVisible;

  useTwoLineFit(promptHeadingRef, [card.card_id, card.prompt_es]);
  useTwoLineFit(answerHeadingRef, [card.card_id, card.answer_en, isAnswerVisible]);

  function resetGesture() {
    gestureStateRef.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      tracking: false,
    };
    setDragOffsetX(0);
  }

  function stopSpeech() {
    if (!canUseSpeechSynthesis()) {
      activeUtteranceRef.current = null;
      return;
    }

    window.speechSynthesis.cancel();
    activeUtteranceRef.current = null;
  }

  function speakText(text, lang, key) {
    const speechText = normalizeSpeechText(text);
    if (!speechText || !canUseSpeechSynthesis()) {
      return;
    }

    const now = Date.now();
    if (lastAutoSpeech.key === key && now - lastAutoSpeech.at < AUTO_SPEECH_DEDUPE_WINDOW_MS) {
      return;
    }

    lastAutoSpeech = { key, at: now };
    stopSpeech();

    const utterance = new window.SpeechSynthesisUtterance(speechText);
    utterance.lang = lang;
    utterance.rate = 0.92;
    utterance.onend = () => {
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
      }
    };
    utterance.onerror = () => {
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
      }
    };

    activeUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  useEffect(() => {
    stopSpeech();
  }, [card.card_id]);

  useEffect(() => {
    speakText(card.prompt_es, 'es-ES', `prompt:${card.card_id}:${card.prompt_es}`);
  }, [card.card_id, card.prompt_es]);

  useEffect(() => {
    const wasAnswerVisible = previousAnswerVisibleRef.current;
    previousAnswerVisibleRef.current = isAnswerVisible;

    if (!isAnswerVisible || wasAnswerVisible) {
      return;
    }

    speakText(card.answer_en, 'en-US', `answer:${card.card_id}:${card.answer_en}`);
  }, [card.answer_en, card.card_id, isAnswerVisible]);

  useEffect(() => () => {
    stopSpeech();
  }, []);

  useEffect(() => {
    resetGesture();
  }, [card.card_id, isAnswerVisible]);

  function handlePlayAnswerSpeech() {
    if (!hasAnswerSpeech) {
      return;
    }

    speakText(card.answer_en, 'en-US', `manual-answer:${card.card_id}:${Date.now()}`);
  }

  function handlePointerDown(event) {
    if (event.pointerType !== 'touch' || !event.isPrimary || isSubmitting || isInteractiveTarget(event.target)) {
      return;
    }

    gestureStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tracking: true,
    };

    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    const gestureState = gestureStateRef.current;

    if (!gestureState.tracking || gestureState.pointerId !== event.pointerId || !isAnswerVisible) {
      return;
    }

    const deltaX = event.clientX - gestureState.startX;
    const deltaY = event.clientY - gestureState.startY;

    if (Math.abs(deltaX) < TAP_REVEAL_TOLERANCE_PX && Math.abs(deltaY) < TAP_REVEAL_TOLERANCE_PX) {
      return;
    }

    if (Math.abs(deltaX) <= Math.abs(deltaY) * HORIZONTAL_SWIPE_RATIO) {
      return;
    }

    event.preventDefault();
    setDragOffsetX(deltaX);
  }

  function handlePointerEnd(event) {
    const gestureState = gestureStateRef.current;

    if (!gestureState.tracking || gestureState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - gestureState.startX;
    const deltaY = event.clientY - gestureState.startY;
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);

    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!isAnswerVisible) {
      resetGesture();
      if (absoluteX <= TAP_REVEAL_TOLERANCE_PX && absoluteY <= TAP_REVEAL_TOLERANCE_PX) {
        onReveal();
      }
      return;
    }

    const isHorizontalSwipe = absoluteX >= SWIPE_REVIEW_THRESHOLD_PX && absoluteX > absoluteY * HORIZONTAL_SWIPE_RATIO;
    resetGesture();

    if (!isHorizontalSwipe) {
      return;
    }

    if (deltaX > 0) {
      onReviewKnown();
      return;
    }

    onReviewUnknown();
  }

  function handlePointerCancel(event) {
    if (gestureStateRef.current.pointerId !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    resetGesture();
  }

  function handleSurfaceClick(event) {
    if (isAnswerVisible || isSubmitting || isInteractiveTarget(event.target)) {
      return;
    }

    onReveal();
  }

  const gestureSurfaceClassName = [
    'flashcard__gesture-surface',
    dragOffsetX !== 0 ? 'flashcard__gesture-surface--dragging' : '',
    swipeFeedback ? `flashcard__gesture-surface--${swipeFeedback}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="panel flashcard">
      <div
        aria-label={
          isAnswerVisible
            ? 'Flashcard answer shown. Swipe left for unknown or right for known on touch devices.'
            : 'Flashcard prompt. Tap to reveal the answer on touch devices.'
        }
        className={gestureSurfaceClassName}
        onClick={handleSurfaceClick}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        role="presentation"
        style={{
          '--flashcard-swipe-rotate': `${dragOffsetX / 18}deg`,
          '--flashcard-swipe-x': `${dragOffsetX}px`,
        }}
      >
        {showRevealHint ? (
          <div className="flashcard__reveal-hint" aria-hidden="true">
            <span className="flashcard__reveal-pill">
              <TapRevealIcon />
              <span>Tap to reveal</span>
            </span>
          </div>
        ) : null}

        {isAnswerVisible ? (
          <div className={`flashcard__swipe-feedback${showSwipeHint ? ' flashcard__swipe-feedback--visible' : ''}`} aria-hidden="true">
            <span className="flashcard__swipe-pill flashcard__swipe-pill--unknown">
              <SwipeDirectionIcon direction="left" />
              <span>I didn't know it</span>
            </span>
            <span className="flashcard__swipe-pill flashcard__swipe-pill--known">
              <span>I knew it</span>
              <SwipeDirectionIcon direction="right" />
            </span>
          </div>
        ) : null}

        <div className="flashcard__face flashcard__face--front">
          {card.section_name ? (
            <div className="flashcard__meta-row">
              {card.section_name ? <span className="flashcard__meta-pill">{card.section_name}</span> : null}
            </div>
          ) : null}
          <p className="flashcard__label">Spanish</p>
          <div className="flashcard__prompt-row">
            <h2 className="flashcard__inline-audio-heading flashcard__fit-heading" ref={promptHeadingRef}>
              <span>{card.prompt_es}</span>
            </h2>
          </div>
          {card.example_es ? <p className="flashcard__example">{card.example_es}</p> : null}
        </div>

        <div className={`answer ${isAnswerVisible ? 'answer--visible' : ''}`}>
          <p className="flashcard__label">English</p>
          {isAnswerVisible ? (
            <div className="answer__content">
              <div className="answer__header">
                <h3 className="flashcard__inline-audio-heading flashcard__fit-heading flashcard__fit-heading--answer" ref={answerHeadingRef}>
                  <span>{card.answer_en}</span>
                  <button
                    aria-label={hasAnswerSpeech ? 'Replay English audio' : 'English audio unavailable'}
                    className="flashcard__audio-button"
                    type="button"
                    onClick={handlePlayAnswerSpeech}
                    disabled={!hasAnswerSpeech}
                    title={hasAnswerSpeech ? 'Replay English audio' : 'English audio unavailable'}
                  >
                    <AudioIcon />
                  </button>
                </h3>
              </div>
              {card.example_en ? <p className="flashcard__example flashcard__example--answer">{card.example_en}</p> : null}
              <button
                aria-label="Show flashcard metadata"
                className="info-button"
                type="button"
                onClick={onOpenDetails}
              >
                i
              </button>
            </div>
          ) : (
            <>
              <h3 className="flashcard__placeholder">?</h3>
            </>
          )}
        </div>
      </div>

      {!hideRevealButton ? (
        <button
          className={`button button--secondary flashcard__reveal${hideRevealButtonOnMobile ? ' flashcard__reveal--mobile-hidden' : ''}`}
          type="button"
          onClick={onToggleReveal}
        >
          {isAnswerVisible ? 'Hide answer' : 'Reveal answer'}
        </button>
      ) : null}
    </section>
  );
}

export default Flashcard;
