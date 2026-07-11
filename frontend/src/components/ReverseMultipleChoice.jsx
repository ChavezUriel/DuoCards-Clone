import MultipleChoice from './MultipleChoice';

// Tier-B recognition game (docs/minigames.md §4 #5): the reverse of Multiple choice
// — show the English answer and have the learner pick the matching Spanish prompt
// from sibling prompt_es tiles. Like every Tier-B game a win never counts (skip),
// only a clean wrong pick records a lapse; it reuses MultipleChoice's tile/keyboard
// engine with the prompt and correct answer swapped to the Spanish side.
//
// The Spanish distractors come from get_minigame_distractors(..., 'es'); when they
// can't be fetched, selectModality/resolveModality degrade this card to another
// modality, so this component always renders with a usable tile set (or the shared
// loading state while the fetch is in flight).
function ReverseMultipleChoice({ card, distractors, onResolve, onOpenDetails }) {
  return (
    <MultipleChoice
      card={card}
      distractors={distractors}
      onResolve={onResolve}
      onOpenDetails={onOpenDetails}
      answer={card.prompt_es}
      answerLabel="Spanish"
      label="Choose the Spanish translation"
      promptNode={<h2 className="mcgame__prompt">{card.answer_en}</h2>}
    />
  );
}

export default ReverseMultipleChoice;
