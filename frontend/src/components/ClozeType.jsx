import { useEffect, useMemo, useRef, useState } from 'react';
import { isGuessCorrect, locateAnswerInExample, normalizeAnswer } from '../minigameText';

// How long the right/wrong feedback lingers before the result is committed. A
// miss dwells longer so the learner can read the correct answer; a hit clears
// quickly to keep momentum. The "Continue" button lets either advance early.
const FEEDBACK_MS = { known: 1100, unknown: 2000 };

// Tier-A production game (docs/minigames.md §3.1, §4 #3): blank the answer out of
// the English example sentence and have the learner type the missing word. The
// sentence is a *cue*, but the word itself is produced from memory — as strong as a
// swipe — so it counts fully: correct -> `known`, wrong -> `unknown`, through the
// identical onResolve({ result, counts }) contract. Selected only when the answer
// can be located as a whole word in example_en (see selectModality); the located
// span is recomputed here to render the blank.
function ClozeType({ card, onResolve }) {
  const [guess, setGuess] = useState('');
  // null while typing; 'known' | 'unknown' once submitted (drives the reveal).
  const [outcome, setOutcome] = useState(null);
  const inputRef = useRef(null);
  const continueRef = useRef(null);
  const resolveTimeoutRef = useRef(null);
  const hasResolvedRef = useRef(false);

  // The raw span of the answer inside the example, so the sentence can be split
  // into "before ___ after". The gate guarantees a match; guard defensively.
  const span = useMemo(
    () => locateAnswerInExample(card.example_en, card.answer_en),
    [card.example_en, card.answer_en],
  );
  const example = card.example_en ?? '';
  const before = span ? example.slice(0, span.start) : '';
  const after = span ? example.slice(span.end) : '';

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
    <section className="panel typegame clozegame">
      {card.section_name ? (
        <div className="typegame__meta-row">
          <span className="flashcard__meta-pill">{card.section_name}</span>
        </div>
      ) : null}

      <div className="typegame__body">
        <p className="flashcard__label">Fill in the missing word</p>
        <p className="clozegame__sentence">
          {before}
          {isRevealed ? (
            <span className={`clozegame__slot clozegame__slot--${outcome}`}>{card.answer_en}</span>
          ) : (
            <span className="clozegame__slot clozegame__slot--blank" aria-label="missing word">
              ______
            </span>
          )}
          {after}
        </p>

        <form className="typegame__form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className={`st-input typegame__input${isRevealed ? ` typegame__input--${outcome}` : ''}`}
            type="text"
            value={guess}
            onChange={(event) => setGuess(event.target.value)}
            placeholder="Type the missing word"
            aria-label="Type the word that fills the gap"
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

export default ClozeType;
