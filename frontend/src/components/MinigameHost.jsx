import Flashcard from './Flashcard';

// Picks which answer modality a card is presented with. Phase 0 always resolves
// to 'classic' (the flip-and-swipe flashcard); later phases branch on the card's
// kind / times_presented / last_result and the games enabled in
// settings.minigames. See docs/minigames.md §8.2 and §6.
export function selectModality(card, settings) {
  // Fallback contract (§7.3): with the master switch off, every card uses the
  // classic flashcard, identical to the app's behavior before minigames existed.
  if (!settings?.minigames?.enabled) {
    return 'classic';
  }

  // No minigames are implemented yet, so nothing is eligible to replace the swipe.
  return 'classic';
}

// Sits where <Flashcard> used to render in PracticePage and owns modality
// selection. Every modality reports its outcome through a single `onResolve`
// contract: { result: 'known' | 'unknown' | null, counts: boolean, skip?: boolean }.
// (`summary`, used for phase-boundary detection, arrives with the boundary games
// in a later phase.)
function MinigameHost({
  card,
  settings,
  onResolve,
  // Classic-modality plumbing owned by PracticePage (reveal state, keyboard
  // bridge, idle hint, details modal). Future modalities won't need most of this.
  isAnswerVisible,
  isSubmitting,
  isIdleHintVisible,
  actionsRef,
  onReveal,
  onToggleReveal,
  onOpenDetails,
}) {
  const modality = selectModality(card, settings);

  if (modality === 'classic') {
    return (
      <Flashcard
        card={card}
        isAnswerVisible={isAnswerVisible}
        isSubmitting={isSubmitting}
        hideRevealButton
        hideRevealButtonOnMobile
        isIdleHintVisible={isIdleHintVisible}
        actionsRef={actionsRef}
        onReveal={onReveal}
        onToggleReveal={onToggleReveal}
        onOpenDetails={onOpenDetails}
        onReviewKnown={() => onResolve({ result: 'known', counts: true })}
        onReviewUnknown={() => onResolve({ result: 'unknown', counts: true })}
      />
    );
  }

  // Unreachable in Phase 0; graded/practice minigame components render here later.
  return null;
}

export default MinigameHost;
