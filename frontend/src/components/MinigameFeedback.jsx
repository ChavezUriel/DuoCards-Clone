import { useEffect, useRef } from 'react';

// Shared reveal feedback for the auto-advancing minigames (multiple choice + the
// typing games). It replaces the old "Correct!/Not quite" verdict *text* with a
// color-coded green/red animation and drives the stoppable auto-advance flow from
// useAutoAdvance:
//   * a green (correct) or red (wrong) mark pops + pulses in — this IS the verdict,
//   * while counting down it shows a depleting timer bar and NO Continue button, plus
//     a quiet hint that a tap or key press will stay the advance,
//   * once the learner stops the countdown it swaps in an explicit Continue button.
//
// `children` is the game's own answer reveal (e.g. the correct answer for a miss),
// rendered between the color mark and the countdown/Continue control.
function MinigameFeedback({ correct, phase, delay, stoppable = true, onAdvance, children }) {
  const tone = correct ? 'correct' : 'wrong';
  const stopped = phase === 'stopped';
  const continueRef = useRef(null);

  // Once stopped, move focus to Continue so a keyboard user advances with Enter/Space
  // (mirrors the focus handling the other minigames use).
  useEffect(() => {
    if (stopped) {
      continueRef.current?.focus();
    }
  }, [stopped]);

  return (
    <div className={`mg-feedback mg-feedback--${tone}`} role="status" aria-live="polite">
      {/* The verdict is conveyed by color; this keeps it available to screen readers. */}
      <span className="sr-only">{correct ? 'Correct' : 'Incorrect'}</span>

      <div className={`mg-feedback__flash mg-feedback__flash--${tone}`} aria-hidden="true">
        <span className="mg-feedback__mark">{correct ? '✓' : '✗'}</span>
      </div>

      {children}

      {stopped ? (
        <button
          ref={continueRef}
          type="button"
          className="button button--primary mg-feedback__continue"
          onClick={onAdvance}
        >
          Continue
        </button>
      ) : (
        <div className="mg-feedback__auto">
          <div className="mg-feedback__timer">
            <span
              className={`mg-feedback__timer-fill mg-feedback__timer-fill--${tone}`}
              style={{ animationDuration: `${delay}ms` }}
            />
          </div>
          {stoppable ? (
            <p className="mg-feedback__hint">Tap or press any key to stay</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default MinigameFeedback;
