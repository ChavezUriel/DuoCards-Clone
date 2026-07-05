import { useEffect, useRef, useState } from 'react';
import { isGuessCorrect, normalizeAnswer } from '../minigameText';

// How long the right/wrong feedback lingers before the result is committed. A
// miss dwells longer so the learner can read the correct answer; a hit clears
// quickly to keep momentum. The "Continue" button lets either advance early.
const FEEDBACK_MS = { known: 1100, unknown: 2000 };

// Tier-A production game (docs/minigames.md §3.1, §4 #2): show the English
// definition (and part of speech) with nothing to recognize, and the learner types
// the English answer. That demands the same free recall as the classic swipe, so a
// correct answer counts as `known` and a wrong one as `unknown` — both flow through
// the identical onResolve({ result, counts }) contract, reaching FSRS exactly like a
// swipe. Selected only when the card carries a definition (see selectModality).
function RecallFromDefinition({ card, onResolve }) {
  const [guess, setGuess] = useState('');
  // null while typing; 'known' | 'unknown' once submitted (drives the reveal).
  const [outcome, setOutcome] = useState(null);
  const inputRef = useRef(null);
  const continueRef = useRef(null);
  const resolveTimeoutRef = useRef(null);
  const hasResolvedRef = useRef(false);

  // Focus the input on mount; once submitted, move focus to Continue so a second
  // Enter (or Space) advances without touching the mouse.
  useEffect(() => {
    if (outcome === null) {
      inputRef.current?.focus();
    } else {
      continueRef.current?.focus();
    }
  }, [outcome]);

  useEffect(() => () => {
    window.clearTimeout(resolveTimeoutRef.current);
  }, []);

  // Idempotent: the auto-timeout and the Continue button both call this, but the
  // card must be graded exactly once.
  function resolveOnce(result) {
    if (hasResolvedRef.current) {
      return;
    }
    hasResolvedRef.current = true;
    window.clearTimeout(resolveTimeoutRef.current);
    onResolve({ result, counts: true });
  }

  function handleSubmit(event) {
    event.preventDefault();

    // Ignore empty/whitespace submits so a stray Enter never records a lapse.
    if (outcome !== null || !normalizeAnswer(guess)) {
      return;
    }

    const result = isGuessCorrect(guess, card) ? 'known' : 'unknown';
    setOutcome(result);
    resolveTimeoutRef.current = window.setTimeout(() => resolveOnce(result), FEEDBACK_MS[result]);
  }

  const isRevealed = outcome !== null;

  return (
    <section className="panel typegame recallgame">
      <div className="typegame__meta-row recallgame__meta-row">
        {card.part_of_speech ? <span className="flashcard__meta-pill">{card.part_of_speech}</span> : null}
        {card.section_name ? <span className="flashcard__meta-pill">{card.section_name}</span> : null}
      </div>

      <div className="typegame__body">
        <p className="flashcard__label">Recall from definition</p>
        <p className="recallgame__definition">{card.definition_en}</p>

        <form className="typegame__form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className={`st-input typegame__input${isRevealed ? ` typegame__input--${outcome}` : ''}`}
            type="text"
            value={guess}
            onChange={(event) => setGuess(event.target.value)}
            placeholder="Type the English word"
            aria-label="Type the English word that matches this definition"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={isRevealed}
          />

          {isRevealed ? (
            <div className={`typegame__feedback typegame__feedback--${outcome}`} role="status" aria-live="polite">
              <p className="typegame__verdict">{outcome === 'known' ? 'Correct!' : 'Not quite'}</p>
              <p className="typegame__answer">
                <span className="typegame__answer-label">Answer</span>
                <span className="typegame__answer-text">{card.answer_en}</span>
              </p>
              <button
                ref={continueRef}
                type="button"
                className="button button--primary typegame__action"
                onClick={() => resolveOnce(outcome)}
              >
                Continue
              </button>
            </div>
          ) : (
            <button type="submit" className="button button--primary typegame__action" disabled={!guess.trim()}>
              Check
            </button>
          )}
        </form>
      </div>
    </section>
  );
}

export default RecallFromDefinition;
