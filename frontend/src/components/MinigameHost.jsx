import Flashcard from './Flashcard';
import TypeTranslation from './TypeTranslation';
import RecallFromDefinition from './RecallFromDefinition';
import ClozeType from './ClozeType';
import MultipleChoice from './MultipleChoice';
import ReverseMultipleChoice from './ReverseMultipleChoice';
import WordBankCloze from './WordBankCloze';
import MnemonicReveal from './MnemonicReveal';
import Listening from './Listening';
import { presentationIndex, shouldPlayPerCardGame } from '../minigameFrequency';
import { locateAnswerInExample } from '../minigameText';

// A card can back the Mnemonic reveal aid only when it actually carries a memory
// hook; without one the aid has nothing to show and we fall through to Listening
// (or classic). See docs/minigames.md §4 (#12).
function hasMnemonic(card) {
  return typeof card?.mnemonic_en === 'string' && card.mnemonic_en.trim().length > 0;
}

// Recall-from-definition needs an English definition to prompt with (§4 #2).
function hasDefinition(card) {
  return typeof card?.definition_en === 'string' && card.definition_en.trim().length > 0;
}

// The cloze games (§4 #3 free-type, #6 word-bank) can only run when the answer is
// locatable as a whole word in the English example, so we can blank exactly it.
// When it isn't, the game drops from the eligible set rather than render a broken
// blank (docs/minigames.md Phase 5 cloze-robustness decision).
function hasClozeSpan(card) {
  return locateAnswerInExample(card?.example_en, card?.answer_en) !== null;
}

// A recognition round needs the correct answer plus at least this many distractors
// (so, 3+ tiles). Below that there aren't enough plausible siblings in the deck to
// make a fair round, and we fall back to another modality.
export const MIN_MC_DISTRACTORS = 2;

// Which distractor side a modality needs, or null when it needs none. Multiple
// choice and word-bank cloze pick an English answer (sibling english_text); reverse
// MC picks a Spanish prompt (sibling spanish_text). PracticePage keys its distractor
// prefetch/cache on this so each recognition game gets the right side (§8.3, §4 #5).
export function recognitionSide(modality) {
  if (modality === 'multiple_choice' || modality === 'word_bank_cloze') {
    return 'en';
  }
  if (modality === 'reverse_mc') {
    return 'es';
  }
  return null;
}

// Turn every recognition (distractor-backed) game off. resolveModality uses this to
// re-pick a production/classic modality when a card's distractors couldn't be
// fetched, so it degrades to something that needs no fetch instead of a broken round.
function withRecognitionGamesDisabled(settings) {
  const games = settings?.minigames?.games ?? {};
  return {
    ...settings,
    minigames: {
      ...settings.minigames,
      games: { ...games, multiple_choice: false, word_bank_cloze: false, reverse_mc: false },
    },
  };
}

// Picks which answer modality a card is presented with, ignoring distractor
// availability (that is layered on by resolveModality). The classic flip-and-swipe
// flashcard is always the ultimate fallback. See docs/minigames.md §8.2 and §6.
//
// Several games can be eligible in one slot now (Phase 5), so the choice among the
// enabled + field-eligible ones is a DETERMINISTIC pick tied to the card
// (card_id + times_presented, via presentationIndex) — mirroring the Phase 3/4
// determinism so the modality never flickers between renders and never stacks a
// second randomizer on top of interleaving_intensity (§6.3).
export function selectModality(card, settings) {
  const minigames = settings?.minigames;

  // Fallback contract (§7.3): with the master switch off, every card uses the
  // classic flashcard, identical to the app's behavior before minigames existed.
  if (!minigames?.enabled) {
    return 'classic';
  }

  // Frequency dose (§6.3, §7.3): 'off' is pure classic; lighter tiers may leave a
  // given presentation on the classic swipe even when a game is eligible below.
  // Deterministic per (card, pass) so the modality never flickers between renders.
  const frequency = minigames.frequency ?? 'balanced';
  if (!shouldPlayPerCardGame(card, frequency)) {
    return 'classic';
  }

  const games = minigames.games ?? {};
  const kind = card?.card_kind;
  const timesPresented = card?.times_presented ?? 0;
  const lastResult = card?.last_result ?? null;

  // Slot — new card's very first exposure (times_presented === 0): Tier-C encoding
  // aids only (§4 #11–#12, §6.1). Pure exposure / a different skill, so they NEVER
  // grade — each resolves via skip, re-queuing the card so its first *graded* rep
  // lands on a later cycle (§3.4). No production or recognition game is offered here:
  // encoding, not measurement. Deterministic preference (mnemonic when the card has a
  // hook, else listening); otherwise today's classic graded swipe.
  if (kind === 'new' && timesPresented === 0) {
    if (games.mnemonic_reveal && hasMnemonic(card)) {
      return 'mnemonic_reveal';
    }
    if (games.listening) {
      return 'listening';
    }
    return 'classic';
  }

  const clozeOk = hasClozeSpan(card);

  // Slot — review card's 1st pass (the retention measurement, §3.3): Tier-A
  // production games only, which demand free recall as strong as the swipe and never
  // reveal the answer first. No recognition game may pre-empt this measurement.
  const isReviewFirstPass = kind === 'review' && lastResult == null;

  // Slot — consolidation: a new card building its trace past first exposure, or a
  // lapsed review being rebuilt (§6.1). Recognition scaffolds (wins skip, clean
  // fails count) plus the cued-recall cloze production game. Recognition never
  // advances graduation; only cloze_free (Tier A) can legitimately count here.
  const isConsolidation =
    (kind === 'new' && timesPresented > 0 && lastResult != null) ||
    (kind === 'review' && lastResult === 'unknown');

  // Ordered preference per slot; each entry is [game, field-eligible?]. Distractor
  // availability for recognition games is confirmed later in resolveModality.
  let candidates = [];
  if (isReviewFirstPass) {
    candidates = [
      ['type_translation', true],
      ['recall_from_definition', hasDefinition(card)],
      ['cloze_free', clozeOk],
    ];
  } else if (isConsolidation) {
    candidates = [
      ['multiple_choice', true],
      ['word_bank_cloze', clozeOk],
      ['reverse_mc', true],
      ['cloze_free', clozeOk],
    ];
  }

  const eligible = candidates
    .filter(([game, fieldOk]) => games[game] && fieldOk)
    .map(([game]) => game);

  if (eligible.length === 0) {
    return 'classic';
  }
  return eligible[presentationIndex(card, eligible.length)];
}

// Final modality once the current card's distractors are known. selectModality may
// pick a recognition game (multiple_choice / word_bank_cloze / reverse_mc)
// optimistically; here we confirm enough distractors were fetched and otherwise fall
// back to a production/classic modality that needs no fetch. `entry` is the per-card
// distractor cache record ({ status, distractors }) for the needed side, or undefined.
export function resolveModality(card, settings, entry) {
  const provisional = selectModality(card, settings);
  const side = recognitionSide(provisional);
  if (!side) {
    return provisional;
  }

  const status = entry?.status ?? 'loading';
  // Still fetching: commit to the recognition game now and let the component show a
  // loading state, so the prompt doesn't flicker through the classic card first.
  if (status === 'loading') {
    return provisional;
  }
  if (status === 'ready' && (entry?.distractors?.length ?? 0) >= MIN_MC_DISTRACTORS) {
    return provisional;
  }

  // Couldn't fetch enough plausible distractors (§8.3 fallback): re-run the gate with
  // every recognition game removed so we degrade to a cloze / production / classic
  // modality — none of which need a fetch — instead of a broken round.
  return selectModality(card, withRecognitionGamesDisabled(settings));
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

  // Shared by every recognition game: null while the fetch is in flight, which the
  // component renders as a brief loading state.
  const distractors = distractorEntry?.status === 'ready' ? distractorEntry.distractors : null;

  // Recognition games (Tier B) — keyed by card + presentation so a re-queued card
  // (same card_id) remounts with fresh selection/reveal state. A win skips (never
  // grades); a clean wrong pick records a lapse (docs/minigames.md §4 #4–#6).
  if (modality === 'multiple_choice') {
    return (
      <MultipleChoice
        key={`${card.card_id}:${card.times_presented ?? 0}`}
        card={card}
        distractors={distractors}
        onResolve={onResolve}
      />
    );
  }

  if (modality === 'reverse_mc') {
    return (
      <ReverseMultipleChoice
        key={`${card.card_id}:${card.times_presented ?? 0}`}
        card={card}
        distractors={distractors}
        onResolve={onResolve}
      />
    );
  }

  if (modality === 'word_bank_cloze') {
    return (
      <WordBankCloze
        key={`${card.card_id}:${card.times_presented ?? 0}`}
        card={card}
        distractors={distractors}
        onResolve={onResolve}
      />
    );
  }

  // Tier-A production games — keyed by card so each new card remounts with fresh
  // input/feedback state. Each owns the whole graded interaction and reports back
  // through the same onResolve contract as the classic swipe (correct -> known,
  // wrong -> unknown). Safe on a review card's first pass (§3.3).
  if (modality === 'type_translation') {
    return <TypeTranslation key={card.card_id} card={card} onResolve={onResolve} />;
  }

  if (modality === 'recall_from_definition') {
    return <RecallFromDefinition key={card.card_id} card={card} onResolve={onResolve} />;
  }

  if (modality === 'cloze_free') {
    return <ClozeType key={card.card_id} card={card} onResolve={onResolve} />;
  }

  // Tier-C encoding aids on a new card's first exposure (§4 #11–#12). Both are pure
  // exposure and resolve via skip only (onResolve({ skip: true })) — never a grade.
  if (modality === 'mnemonic_reveal') {
    return <MnemonicReveal key={card.card_id} card={card} onResolve={onResolve} />;
  }

  if (modality === 'listening') {
    return <Listening key={card.card_id} card={card} onResolve={onResolve} />;
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
