import { useEffect, useRef, useState } from 'react';
import { cancelSpeech, canUseSpeechSynthesis, speak } from '../speech';

// Tier-C encoding aid (docs/minigames.md §3.1, §4 #12) shown on a NEW card's very
// first exposure. It is pure exposure — the Spanish prompt, the English answer, and
// the memory hook are all revealed at once so the learner can *encode* the word
// before it is ever tested. It carries no es→en retrieval signal, so it NEVER
// grades: Continue advances via onResolve({ skip: true }), which re-queues the card
// for a real free-recall rep on a later cycle (§3.4, §6.1). Selected only when the
// card actually has a mnemonic (see MinigameHost.selectModality).
function MnemonicReveal({ card, onResolve }) {
  const continueRef = useRef(null);
  const hasResolvedRef = useRef(false);
  const speakTokenRef = useRef(0);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const hasAnswerSpeech = canUseSpeechSynthesis() && Boolean((card.answer_en ?? '').trim());

  // Focus Continue on mount so Enter/Space advances immediately (§8.4), with no
  // pointer required. There is nothing to answer — it's a reveal.
  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  // Stop any in-flight audio when the aid unmounts (e.g. the learner hits Continue
  // mid-playback), so speech never bleeds into the next card.
  useEffect(() => () => cancelSpeech(), []);

  function playAnswer() {
    if (!hasAnswerSpeech) {
      return;
    }
    const token = (speakTokenRef.current += 1);
    const utterance = speak(card.answer_en, {
      lang: 'en-US',
      onEnd: () => {
        if (speakTokenRef.current === token) {
          setIsSpeaking(false);
        }
      },
    });
    setIsSpeaking(Boolean(utterance));
  }

  // Idempotent: guards against a double-tap / rapid Enter double-firing the skip.
  function handleContinue() {
    if (hasResolvedRef.current) {
      return;
    }
    hasResolvedRef.current = true;
    onResolve({ skip: true });
  }

  return (
    <section className="panel mnemonicgame">
      {card.section_name ? (
        <div className="mnemonicgame__meta-row">
          <span className="flashcard__meta-pill">{card.section_name}</span>
        </div>
      ) : null}

      <div className="mnemonicgame__body">
        <p className="flashcard__label">New word · memory hook</p>
        <h2 className="mnemonicgame__prompt">{card.prompt_es}</h2>

        <p className="mnemonicgame__answer">
          <span className="mnemonicgame__answer-label">English</span>
          <span className="mnemonicgame__answer-text">
            {card.answer_en}
            <button
              type="button"
              className={`flashcard__audio-button${isSpeaking ? ' flashcard__audio-button--playing' : ''}`}
              onClick={playAnswer}
              disabled={!hasAnswerSpeech}
              aria-label={hasAnswerSpeech ? 'Play English audio' : 'English audio unavailable'}
              title={hasAnswerSpeech ? 'Play English audio' : 'English audio unavailable'}
            >
              <AudioIcon />
            </button>
          </span>
        </p>

        {card.mnemonic_en ? (
          <p className="mnemonicgame__mnemonic">
            <span className="mnemonicgame__mnemonic-label">Memory hook</span>
            {card.mnemonic_en}
          </p>
        ) : null}

        <button
          ref={continueRef}
          type="button"
          className="button button--primary mnemonicgame__action"
          onClick={handleContinue}
        >
          Continue
        </button>
      </div>
    </section>
  );
}

// Inline copy of Flashcard's speaker glyph so this aid stays self-contained.
function AudioIcon() {
  return (
    <svg aria-hidden="true" className="flashcard__audio-icon" viewBox="0 0 24 24">
      <path d="M3.75 9.5h4.1l4.4-3.55a.75.75 0 0 1 1.22.6v10.9a.75.75 0 0 1-1.22.6L7.85 14.5h-4.1A1.25 1.25 0 0 1 2.5 13.25v-2.5A1.25 1.25 0 0 1 3.75 9.5Z" fill="currentColor" />
      <path d="M16.55 8.2a.75.75 0 0 1 1.06.08 5.63 5.63 0 0 1 0 7.44.75.75 0 1 1-1.14-.98 4.12 4.12 0 0 0 0-5.48.75.75 0 0 1 .08-1.06Z" fill="currentColor" />
      <path d="M18.97 5.74a.75.75 0 0 1 1.06.07 9.38 9.38 0 0 1 0 12.38.75.75 0 1 1-1.14-.97 7.88 7.88 0 0 0 0-10.44.75.75 0 0 1 .08-1.04Z" fill="currentColor" />
    </svg>
  );
}

export default MnemonicReveal;
