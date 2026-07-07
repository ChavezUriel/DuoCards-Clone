import { useState } from 'react';

// Two-step hint ladder shared by the free-type production games — Recall from
// definition and the free-type cloze (docs/minigames.md §4 #2–#3). Step 1 reveals
// the answer's *shape* (one underscore per character, with word gaps preserved so a
// multi-word answer shows where its spaces fall); step 2 additionally shows the
// Spanish side of the card. Hints never change grading: a hinted correct answer
// still resolves `known`, so the ladder trades recall difficulty for momentum
// without touching the FSRS contract.
export const MAX_HINT_LEVEL = 2;

// The button always advertises what the NEXT press reveals, so the learner knows
// what they're spending a hint on before committing.
const NEXT_HINT_LABEL = ['Hint: word shape', 'Hint: in Spanish'];

// Hint state for one round. `reveal` bumps the level and hands focus straight back
// to the answer input: the button sits immediately after the input in DOM order
// (exactly one Tab away), so a keyboard user tabs over, presses it, and lands back
// where they type. Games remount per card (keyed by card_id), which resets the level.
export function useHints(inputRef) {
  const [level, setLevel] = useState(0);

  function reveal() {
    setLevel((current) => Math.min(current + 1, MAX_HINT_LEVEL));
    inputRef.current?.focus();
  }

  return { level, reveal };
}

// The hint trigger. `type="button"` keeps it out of the form's implicit submission,
// so Enter in the input still submits the guess. Once both hints are spent it stays
// mounted but disabled — the layout doesn't jump and the tab order stays put.
export function HintButton({ level, onReveal }) {
  const exhausted = level >= MAX_HINT_LEVEL;
  return (
    <button
      type="button"
      className="button typegame__hint-btn"
      onClick={onReveal}
      disabled={exhausted}
    >
      {exhausted ? 'No more hints' : NEXT_HINT_LABEL[level]}
    </button>
  );
}

// Step-1 hint: the answer rendered as blanks — one underscore per character, one
// run per word — so length and word breaks show without leaking any letters.
// Underscore glyphs run together visually, so each character gets its own span and
// CSS gaps do the separating (a wider gap marks the spaces).
export function AnswerShape({ answer }) {
  const words = (answer ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return null;
  }

  const letterCounts = words.map((word) => Array.from(word).length);
  return (
    <span
      className="hintshape"
      role="img"
      aria-label={`Word shape: ${letterCounts.join(' + ')} letters`}
    >
      {words.map((word, wordIndex) => (
        <span key={wordIndex} className="hintshape__word" aria-hidden="true">
          {Array.from(word).map((_, charIndex) => (
            <span key={charIndex} className="hintshape__char">
              _
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

// Step-2 hint: the word on the other side of the card (prompt_es for these en-answer
// games), labeled like the reveal's answer block so the visual language matches.
export function TranslationHint({ text }) {
  if (!text) {
    return null;
  }
  return (
    <p className="typegame__hint-translation">
      <span className="typegame__answer-label">In Spanish</span>
      <span className="typegame__hint-word">{text}</span>
    </p>
  );
}
