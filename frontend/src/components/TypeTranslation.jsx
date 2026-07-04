import { useEffect, useRef, useState } from 'react';

// How long the right/wrong feedback lingers before the result is committed. A
// miss dwells longer so the learner can read the correct answer; a hit clears
// quickly to keep momentum. The "Continue" button lets either advance early.
const FEEDBACK_MS = { known: 1100, unknown: 2000 };

// Per docs/minigames.md Phase 1: normalize by trim + lowercase + strip diacritics
// before comparing. We also unify the Unicode hyphens/dashes and curly apostrophes
// that show up in real card data, and collapse internal whitespace, so a plain
// keyboard answer still matches (e.g. seed synonym "hold‑up" vs typed "hold-up").
function normalizeAnswer(value) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[‐-―−]/g, '-') // hyphens/dashes/minus -> ASCII hyphen
    .replace(/[‘’ʼ]/g, "'") // curly/modifier apostrophes -> ASCII '
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// A guess is correct when, after normalization, it exactly matches the primary
// answer or any listed English synonym.
function isGuessCorrect(guess, card) {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) {
    return false;
  }

  const candidates = [card.answer_en, ...(card.synonyms_en ?? [])];
  return candidates.some((candidate) => normalizeAnswer(candidate) === normalizedGuess);
}

// Tier-A production game (docs/minigames.md §3.1): the learner types the English
// for prompt_es with nothing on screen to recognize, so it demands the same free
// recall as the classic swipe. A correct answer counts as `known`, a wrong one as
// `unknown` — both flow through the identical onResolve({ result, counts }) contract
// the classic flashcard uses, so they reach FSRS exactly like a right/left swipe.
function TypeTranslation({ card, onResolve }) {
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
            onChange={(event) => setGuess(event.target.value)}
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

export default TypeTranslation;
