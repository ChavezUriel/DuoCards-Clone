import { useEffect, useRef, useState } from 'react';
import { isGuessCorrect, normalizeAnswer } from '../minigameText';
import MinigameFeedback from './MinigameFeedback';
import { useAutoAdvance } from '../useAutoAdvance';

// How long the right/wrong feedback lingers before it auto-advances. A miss dwells
// longer so the learner can read the correct answer; a hit clears quickly to keep
// momentum. A click or key press during the window stays the advance and surfaces a
// Continue button instead (see useAutoAdvance).
const FEEDBACK_MS = { known: 1100, unknown: 2000 };

// Tier-A production game (docs/minigames.md §3.1): the learner types the English
// for prompt_es with nothing on screen to recognize, so it demands the same free
// recall as the classic swipe. A correct answer counts as `known`, a wrong one as
// `unknown` — both flow through the identical onResolve({ result, counts }) contract
// the classic flashcard uses, so they reach FSRS exactly like a right/left swipe.
function TypeTranslation({ card, onResolve }) {
  const [guess, setGuess] = useState('');
  // null while typing; 'known' | 'unknown' once submitted (drives the reveal).
  const [outcome, setOutcome] = useState(null);
  // First empty submit arms a "Sure?" skip confirmation; the second one skips.
  const [confirmSkip, setConfirmSkip] = useState(false);
  const inputRef = useRef(null);
  const autoAdvance = useAutoAdvance();

  // Focus the input while typing; once submitted, MinigameFeedback owns focus (its
  // Continue button, shown if the learner stays the auto-advance).
  useEffect(() => {
    if (outcome === null) {
      inputRef.current?.focus();
    }
  }, [outcome]);

  function handleSubmit(event) {
    event.preventDefault();

    if (outcome !== null) {
      return;
    }

    // Empty input → offer to skip the card, but require a second submit to confirm
    // (double-Enter) so a stray Enter never discards the rep. A skipped guess is a
    // genuine "couldn't recall it", so it grades `unknown` and reveals the answer,
    // exactly like a wrong guess.
    if (!normalizeAnswer(guess)) {
      if (!confirmSkip) {
        setConfirmSkip(true);
        return;
      }
      setConfirmSkip(false);
      setOutcome('unknown');
      autoAdvance.arm(FEEDBACK_MS.unknown, () => onResolve({ result: 'unknown', counts: true }));
      return;
    }

    const result = isGuessCorrect(guess, card) ? 'known' : 'unknown';
    setOutcome(result);
    // The hook keeps this idempotent across the timer and the Continue button.
    autoAdvance.arm(FEEDBACK_MS[result], () => onResolve({ result, counts: true }));
  }

  const isRevealed = outcome !== null;

  return (
    <section className="panel typegame">
      {card.section_name ? (
        <div className="typegame__meta-row">
          <span className="flashcard__meta-pill">{card.section_name}</span>
        </div>
      ) : null}

      <div className="typegame__body">
        <p className="flashcard__label">Type the translation</p>
        <h2 className="typegame__prompt">{card.prompt_es}</h2>
        {card.example_es ? <p className="flashcard__example typegame__example">{card.example_es}</p> : null}

        <form className="typegame__form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className={`st-input typegame__input${isRevealed ? ` typegame__input--${outcome}` : ''}`}
            type="text"
            value={guess}
            onChange={(event) => {
              setGuess(event.target.value);
              // Typing again abandons a pending skip prompt.
              if (confirmSkip) {
                setConfirmSkip(false);
              }
            }}
            placeholder="Type the English answer"
            aria-label="Type the English translation"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            disabled={isRevealed}
          />

          {isRevealed ? (
            <MinigameFeedback
              correct={outcome === 'known'}
              phase={autoAdvance.phase}
              delay={FEEDBACK_MS[outcome]}
              onAdvance={autoAdvance.advance}
            >
              <p className="typegame__answer">
                <span className="typegame__answer-label">Answer</span>
                <span className="typegame__answer-text">{card.answer_en}</span>
              </p>
            </MinigameFeedback>
          ) : (
            <button
              type="submit"
              className={
                guess.trim()
                  ? 'button button--primary typegame__action'
                  : `button typegame__action typegame__action--skip${confirmSkip ? ' typegame__action--confirm' : ''}`
              }
            >
              {guess.trim() ? 'Check' : confirmSkip ? 'Sure?' : 'Skip'}
            </button>
          )}
        </form>
      </div>
    </section>
  );
}

export default TypeTranslation;
