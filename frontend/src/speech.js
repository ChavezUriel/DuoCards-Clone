// Thin wrapper over the Web Speech API, mirroring the approach already used in
// Flashcard.jsx (window.speechSynthesis) so the Phase 4 encoding aids can read a
// word aloud without pulling in a TTS dependency. See docs/minigames.md §4 (#11).

export function canUseSpeechSynthesis() {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

// Speak `text`, cancelling anything already queued so a replay never stacks. Wires
// the caller's onEnd to both `onend` and `onerror` (a cancel fires one of them), so
// UI "speaking" state always clears. Returns the utterance, or null when speech is
// unavailable / the text is empty — callers use that to know a play actually began.
//
// Unlike Flashcard's auto-speech there is no dedupe window here: every call is an
// explicit user tap (Play / replay), so it should always fire.
export function speak(text, { lang = 'en-US', rate = 0.92, onEnd } = {}) {
  const speechText = typeof text === 'string' ? text.trim() : '';
  if (!speechText || !canUseSpeechSynthesis()) {
    return null;
  }

  window.speechSynthesis.cancel();

  const utterance = new window.SpeechSynthesisUtterance(speechText);
  utterance.lang = lang;
  utterance.rate = rate;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();

  window.speechSynthesis.speak(utterance);
  return utterance;
}

export function cancelSpeech() {
  if (canUseSpeechSynthesis()) {
    window.speechSynthesis.cancel();
  }
}
