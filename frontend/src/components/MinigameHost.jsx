import Flashcard from './Flashcard';
import TypeTranslation from './TypeTranslation';

// Picks which answer modality a card is presented with. The classic flip-and-swipe
// flashcard is always the fallback; enabled games branch on the card's kind (and,
// from Phase 2, times_presented / last_result). See docs/minigames.md §8.2 and §6.
export function selectModality(card, settings) {
  const minigames = settings?.minigames;

  // Fallback contract (§7.3): with the master switch off, every card uses the
  // classic flashcard, identical to the app's behavior before minigames existed.
  if (!minigames?.enabled) {
    return 'classic';
  }

  // Tier-A "Type the translation" (§4 #1). Eligible on a review card's first pass,
  // which for now we key purely off card_kind === 'review' — the times_presented /
  // last_result snapshot fields that would distinguish a first pass from a lapsed
  // re-queue arrive in Phase 2. Typing is free recall, so it counts fully and is
  // safe on a due card's first pass (guardrail §3.3).
  if (minigames.games?.type_translation && card?.card_kind === 'review') {
    return 'type_translation';
  }

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

  if (modality === 'type_translation') {
    // Keyed by card so each new card remounts the game with fresh input/feedback
    // state. It owns the whole graded interaction and reports back through the same
    // onResolve contract as the classic swipe (correct -> known, wrong -> unknown).
    return <TypeTranslation key={card.card_id} card={card} onResolve={onResolve} />;
  }

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

  // selectModality only returns modalities handled above; null is a defensive
  // fallback should an unknown one ever slip through.
  return null;
}

export default MinigameHost;
