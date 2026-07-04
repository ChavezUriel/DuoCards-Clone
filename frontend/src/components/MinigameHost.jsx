import Flashcard from './Flashcard';
import TypeTranslation from './TypeTranslation';
import MultipleChoice from './MultipleChoice';
import { shouldPlayPerCardGame } from '../minigameFrequency';

// A multiple-choice round needs the correct answer plus at least this many
// distractors (so, 3+ tiles). Below that there aren't enough plausible siblings
// in the deck to make a fair round, and we fall back to another modality.
export const MIN_MC_DISTRACTORS = 2;

// Picks which answer modality a card is presented with, ignoring distractor
// availability (that is layered on by resolveModality). The classic flip-and-swipe
// flashcard is always the ultimate fallback. See docs/minigames.md §8.2 and §6.
export function selectModality(card, settings) {
  const minigames = settings?.minigames;

  // Fallback contract (§7.3): with the master switch off, every card uses the
  // classic flashcard, identical to the app's behavior before minigames existed.
  if (!minigames?.enabled) {
    return 'classic';
  }

  // Frequency dose (§6.3, §7.3): 'off' is pure classic; lighter tiers may leave a
  // given presentation on the classic swipe even when a game is eligible below.
  // Deterministic per (card, pass) so the modality never flickers between renders,
  // and 'balanced'/'heavy' always pass — keeping the Phase 0–2 typing/MC behavior
  // exactly as shipped at the default frequency.
  const frequency = minigames.frequency ?? 'balanced';
  if (!shouldPlayPerCardGame(card, frequency)) {
    return 'classic';
  }

  const games = minigames.games ?? {};
  const kind = card?.card_kind;
  const timesPresented = card?.times_presented ?? 0;
  const lastResult = card?.last_result ?? null;

  // Tier-B "Multiple choice" (§4 #4) — recognition, so a win never counts. It is
  // eligible in two spots (§6.1): a lapsed review being rebuilt, and a new card
  // consolidating its trace past the first exposure.
  //
  // Both branches require last_result to still carry a *graded* result from the
  // previous pass. A skip clears last_result to null (0013), so this can never
  // fire twice running on the same card — a free-recall rep (classic / typing)
  // always follows, which is what actually advances the 2-streak and lets the
  // card graduate or leave (guardrail §3.3). The first pass of a review card has
  // last_result null too, so recognition never pre-empts that free-recall
  // measurement (guardrail §3.1). New first exposure (times_presented 0) also
  // stays classic — Phase 1 behavior is unchanged.
  if (games.multiple_choice) {
    const isLapsedReview = kind === 'review' && lastResult === 'unknown';
    const isNewConsolidating = kind === 'new' && timesPresented > 0 && lastResult != null;
    if (isLapsedReview || isNewConsolidating) {
      return 'multiple_choice';
    }
  }

  // Tier-A "Type the translation" (§4 #1) — free recall, counts fully, safe on a
  // review card's first pass (guardrail §3.3). Runs when MC didn't claim the card.
  if (games.type_translation && kind === 'review') {
    return 'type_translation';
  }

  return 'classic';
}

// Final modality once the current card's distractors are known. selectModality
// may pick 'multiple_choice' optimistically; here we confirm enough distractors
// were fetched and otherwise fall back to the next-best modality. `entry` is the
// per-card distractor cache record ({ status, distractors }) or undefined.
export function resolveModality(card, settings, entry) {
  const provisional = selectModality(card, settings);
  if (provisional !== 'multiple_choice') {
    return provisional;
  }

  const status = entry?.status ?? 'loading';
  // Still fetching: commit to MC now and let the component show a loading state,
  // so the prompt doesn't flicker through the classic card first.
  if (status === 'loading') {
    return 'multiple_choice';
  }
  if (status === 'ready' && (entry?.distractors?.length ?? 0) >= MIN_MC_DISTRACTORS) {
    return 'multiple_choice';
  }

  // Couldn't fetch enough plausible distractors (§8.3 fallback): re-run the gate
  // with MC removed so we degrade to typing / classic instead of a broken round.
  return selectModality(card, {
    ...settings,
    minigames: {
      ...settings.minigames,
      games: { ...(settings.minigames?.games ?? {}), multiple_choice: false },
    },
  });
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
  // Per-card distractor cache record for the current card ({ status, distractors }),
  // owned by PracticePage which fetches and caches it. Undefined until fetched.
  distractorEntry,
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
  const modality = resolveModality(card, settings, distractorEntry);

  if (modality === 'multiple_choice') {
    // Keyed by card + presentation so a re-queued card (same card_id) remounts
    // with fresh selection/reveal state. `distractors` is null while the fetch is
    // in flight, which the component renders as a brief loading state.
    const distractors = distractorEntry?.status === 'ready' ? distractorEntry.distractors : null;
    return (
      <MultipleChoice
        key={`${card.card_id}:${card.times_presented ?? 0}`}
        card={card}
        distractors={distractors}
        onResolve={onResolve}
      />
    );
  }

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

  // resolveModality only returns modalities handled above; null is a defensive
  // fallback should an unknown one ever slip through.
  return null;
}

export default MinigameHost;
