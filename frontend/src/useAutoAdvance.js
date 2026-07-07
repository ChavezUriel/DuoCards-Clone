import { useCallback, useEffect, useRef, useState } from 'react';

// Shared "reveal → auto-advance, but let the learner stop it" mechanism for the
// graded/skip minigames (multiple choice + the typing games). It replaces the old
// "reveal + Continue button + auto-timeout" pattern each of those games hand-rolled.
//
// On reveal a game calls arm(delay, onAdvance):
//   * a countdown runs and calls onAdvance() when it elapses (the automatic advance),
//   * while it's counting, a click anywhere or any key press STOPS it — the learner
//     wants to linger on the color feedback / correct answer instead of racing on,
//   * once stopped, the game shows an explicit Continue control that calls advance().
//
// advance() is idempotent, so the elapsed timer, a stop-then-Continue, and any late
// callback can race without ever resolving the card twice. Games that must not be
// interruptible (e.g. the rapid-fire speed round) pass { stoppable: false }, which
// keeps the countdown but ignores clicks/keys so it always just advances.
export function useAutoAdvance({ stoppable = true } = {}) {
  // 'idle' before the answer is revealed, 'counting' while the auto-advance timer
  // runs, 'stopped' once the learner has interrupted it.
  const [phase, setPhase] = useState('idle');
  const timeoutRef = useRef(null);
  const advanceFnRef = useRef(null);
  const doneRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Commit the advance exactly once, whoever gets here first (timer, Continue button).
  const advance = useCallback(() => {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    clearTimer();
    advanceFnRef.current?.();
  }, [clearTimer]);

  // Cancel the countdown so the learner can stay; only meaningful while counting.
  const stop = useCallback(() => {
    if (doneRef.current) {
      return;
    }
    clearTimer();
    setPhase((current) => (current === 'counting' ? 'stopped' : current));
  }, [clearTimer]);

  // Begin the countdown once an answer is revealed.
  const arm = useCallback((delay, onAdvance) => {
    advanceFnRef.current = onAdvance;
    doneRef.current = false;
    clearTimer();
    setPhase('counting');
    timeoutRef.current = window.setTimeout(advance, delay);
  }, [advance, clearTimer]);

  // Stop on any click or key press while counting. Bound in an effect (not inline in
  // arm) so it attaches only AFTER the render that armed the countdown — the very
  // Enter/click that submitted the answer has already been dispatched by then, so it
  // can never immediately cancel the countdown it just started.
  useEffect(() => {
    if (!stoppable || phase !== 'counting') {
      return undefined;
    }
    function handleKeyDown(event) {
      // A bare modifier tap (Shift/Ctrl/Alt/Meta) isn't an intent to stay.
      if (
        event.key === 'Shift' ||
        event.key === 'Control' ||
        event.key === 'Alt' ||
        event.key === 'Meta'
      ) {
        return;
      }
      stop();
    }
    function handlePointerDown() {
      stop();
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [stoppable, phase, stop]);

  // Never leave a timer running if the game unmounts mid-countdown (card advanced,
  // session ended, learner navigated away).
  useEffect(() => () => clearTimer(), [clearTimer]);

  return { phase, isCounting: phase === 'counting', isStopped: phase === 'stopped', arm, stop, advance };
}
