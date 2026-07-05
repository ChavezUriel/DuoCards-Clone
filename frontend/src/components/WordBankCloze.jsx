import { useMemo } from 'react';
import MultipleChoice from './MultipleChoice';
import { locateAnswerInExample } from '../minigameText';

// Tier-B recognition game (docs/minigames.md §4 #6): blank the answer out of the
// English example sentence and have the learner pick the missing word from a bank of
// tiles (the real answer + sibling English distractors). Because the word is chosen
// from options, a win could come from elimination, so — like every Tier-B game — a
// win never counts (skip) and only a clean wrong pick records a lapse. It reuses
// MultipleChoice's tile/keyboard engine, swapping the prompt for the cloze sentence.
//
// Selected only when the answer is locatable in example_en and English distractors
// are available (see selectModality/resolveModality); the span is recomputed here to
// render the blank.
function WordBankCloze({ card, distractors, onResolve }) {
  const span = useMemo(
    () => locateAnswerInExample(card.example_en, card.answer_en),
    [card.example_en, card.answer_en],
  );
  const example = card.example_en ?? '';
  const before = span ? example.slice(0, span.start) : '';
  const after = span ? example.slice(span.end) : '';

  const promptNode = (
    <p className="clozegame__sentence wordbankgame__sentence">
      {before}
      <span className="clozegame__slot clozegame__slot--blank" aria-label="missing word">
        ______
      </span>
      {after}
    </p>
  );

  return (
    <MultipleChoice
      card={card}
      distractors={distractors}
      onResolve={onResolve}
      label="Fill the gap"
      promptNode={promptNode}
    />
  );
}

export default WordBankCloze;
