// Shared text helpers for the answer-matching minigames. Kept in one module so the
// Tier-A free-type games (Type the translation, Recall from definition, Cloze) all
// normalize and compare answers identically, and so the cloze games locate the
// blank the same way. See docs/minigames.md §4 (#1–#3, #6), Phase 1 & Phase 5.

// Normalize an answer for comparison: trim + lowercase + strip diacritics, and
// unify the Unicode hyphens/dashes and curly apostrophes that show up in real card
// data, collapsing internal whitespace. So a plain keyboard answer still matches a
// seeded synonym (e.g. "hold‑up" vs typed "hold-up").
export function normalizeAnswer(value) {
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
export function isGuessCorrect(guess, card) {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) {
    return false;
  }

  const candidates = [card.answer_en, ...(card.synonyms_en ?? [])];
  return candidates.some((candidate) => normalizeAnswer(candidate) === normalizedGuess);
}

// A word token: a Unicode letter run, allowing internal apostrophes/hyphens so
// "don't" and "hold-up" stay single tokens.
const WORD_RE = /\p{L}[\p{L}\p{M}'’-]*/gu;

// Find `answer` as a whole word (or whole multi-word run) inside `example`, matching
// case/diacritic-insensitively at word boundaries, and return the { start, end } span
// into the RAW example string so a cloze game can blank exactly that slice.
//
// Returns null when the answer can't be located (inflected form, multi-word split,
// or simply absent) — the caller then drops the cloze modality rather than render a
// broken blank (docs/minigames.md §4 #3, Phase 5 cloze-robustness decision).
export function locateAnswerInExample(example, answer) {
  const text = typeof example === 'string' ? example : '';
  const target = normalizeAnswer(answer);
  if (!text || !target) {
    return null;
  }

  // Tokenize the example into words, remembering each token's raw span and its
  // normalized form.
  const tokens = [];
  for (const match of text.matchAll(WORD_RE)) {
    tokens.push({
      norm: normalizeAnswer(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  if (tokens.length === 0) {
    return null;
  }

  const targetWords = target.split(' ');
  const span = targetWords.length;

  // Slide a window the width of the answer across the tokens; the first run whose
  // normalized tokens all match wins. This handles multi-word answers ("give up").
  for (let i = 0; i + span <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < span; j += 1) {
      if (tokens[i + j].norm !== targetWords[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start: tokens[i].start, end: tokens[i + span - 1].end };
    }
  }
  return null;
}
