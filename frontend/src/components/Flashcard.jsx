import { useEffect, useRef, useState } from 'react';

const AUTO_SPEECH_DEDUPE_WINDOW_MS = 750;
let lastAutoSpeech = {
  key: '',
  at: 0,
};

function canUseSpeechSynthesis() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function normalizeSpeechText(text) {
  return typeof text === 'string' ? text.trim() : '';
}

function AudioIcon() {
  return (
    <svg aria-hidden="true" className="flashcard__audio-icon" viewBox="0 0 24 24">
      <path d="M3.75 9.5h4.1l4.4-3.55a.75.75 0 0 1 1.22.6v10.9a.75.75 0 0 1-1.22.6L7.85 14.5h-4.1A1.25 1.25 0 0 1 2.5 13.25v-2.5A1.25 1.25 0 0 1 3.75 9.5Z" fill="currentColor" />
      <path d="M16.55 8.2a.75.75 0 0 1 1.06.08 5.63 5.63 0 0 1 0 7.44.75.75 0 1 1-1.14-.98 4.12 4.12 0 0 0 0-5.48.75.75 0 0 1 .08-1.06Z" fill="currentColor" />
      <path d="M18.97 5.74a.75.75 0 0 1 1.06.07 9.38 9.38 0 0 1 0 12.38.75.75 0 1 1-1.14-.97 7.88 7.88 0 0 0 0-10.44.75.75 0 0 1 .08-1.04Z" fill="currentColor" />
    </svg>
  );
}

function Flashcard({ card, isAnswerVisible, onReveal }) {
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const activeUtteranceRef = useRef(null);
  const previousAnswerVisibleRef = useRef(isAnswerVisible);
  const shouldShowDeckTitle = card.deck_title && card.deck_title !== card.section_name;
  const hasAnswerSpeech = canUseSpeechSynthesis() && Boolean(normalizeSpeechText(card.answer_en));

  function stopSpeech() {
    if (!canUseSpeechSynthesis()) {
      activeUtteranceRef.current = null;
      return;
    }

    window.speechSynthesis.cancel();
    activeUtteranceRef.current = null;
  }

  function speakText(text, lang, key) {
    const speechText = normalizeSpeechText(text);
    if (!speechText || !canUseSpeechSynthesis()) {
      return;
    }

    const now = Date.now();
    if (lastAutoSpeech.key === key && now - lastAutoSpeech.at < AUTO_SPEECH_DEDUPE_WINDOW_MS) {
      return;
    }

    lastAutoSpeech = { key, at: now };
    stopSpeech();

    const utterance = new window.SpeechSynthesisUtterance(speechText);
    utterance.lang = lang;
    utterance.rate = 0.92;
    utterance.onend = () => {
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
      }
    };
    utterance.onerror = () => {
      if (activeUtteranceRef.current === utterance) {
        activeUtteranceRef.current = null;
      }
    };

    activeUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [isAnswerVisible, card.card_id]);

  useEffect(() => {
    stopSpeech();
  }, [card.card_id]);

  useEffect(() => {
    speakText(card.prompt_es, 'es-ES', `prompt:${card.card_id}:${card.prompt_es}`);
  }, [card.card_id, card.prompt_es]);

  useEffect(() => {
    const wasAnswerVisible = previousAnswerVisibleRef.current;
    previousAnswerVisibleRef.current = isAnswerVisible;

    if (!isAnswerVisible || wasAnswerVisible) {
      return;
    }

    speakText(card.answer_en, 'en-US', `answer:${card.card_id}:${card.answer_en}`);
  }, [card.answer_en, card.card_id, isAnswerVisible]);

  useEffect(() => () => {
    stopSpeech();
  }, []);

  function handlePlayAnswerSpeech() {
    if (!hasAnswerSpeech) {
      return;
    }

    speakText(card.answer_en, 'en-US', `manual-answer:${card.card_id}:${Date.now()}`);
  }

  return (
    <>
      <section className="panel flashcard">
        <div className="flashcard__face flashcard__face--front">
          {card.section_name || card.deck_title ? (
            <div className="flashcard__meta-row">
              {card.section_name ? <span className="flashcard__meta-pill">{card.section_name}</span> : null}
              {shouldShowDeckTitle ? <span className="flashcard__meta-pill flashcard__meta-pill--secondary">{card.deck_title}</span> : null}
            </div>
          ) : null}
          <p className="flashcard__label">Spanish</p>
          <div className="flashcard__prompt-row">
            <h2 className="flashcard__inline-audio-heading">
              <span>{card.prompt_es}</span>
            </h2>
          </div>
          {card.example_es ? <p className="flashcard__example">{card.example_es}</p> : null}
        </div>

        <div className={`answer ${isAnswerVisible ? 'answer--visible' : ''}`}>
          <p className="flashcard__label">English</p>
          {isAnswerVisible ? (
            <div className="answer__content">
              <div className="answer__header">
                <h3 className="flashcard__inline-audio-heading">
                  <span>{card.answer_en}</span>
                  <button
                    aria-label={hasAnswerSpeech ? 'Replay English audio' : 'English audio unavailable'}
                    className="flashcard__audio-button"
                    type="button"
                    onClick={handlePlayAnswerSpeech}
                    disabled={!hasAnswerSpeech}
                    title={hasAnswerSpeech ? 'Replay English audio' : 'English audio unavailable'}
                  >
                    <AudioIcon />
                  </button>
                </h3>
              </div>
              {card.example_en ? <p className="flashcard__example flashcard__example--answer">{card.example_en}</p> : null}
              <button
                aria-expanded={isDetailsVisible}
                aria-label={isDetailsVisible ? 'Hide word details' : 'Show word details'}
                className="info-button"
                type="button"
                onClick={() => setIsDetailsVisible(true)}
              >
                i
              </button>
            </div>
          ) : (
            <h3 className="flashcard__placeholder">?</h3>
          )}
        </div>

        <button className="button button--secondary flashcard__reveal" type="button" onClick={onReveal}>
          {isAnswerVisible ? 'Hide answer' : 'Reveal answer'}
        </button>
      </section>

      {isDetailsVisible ? (
        <div className="details-modal" role="dialog" aria-modal="true" aria-label="Word details">
          <button
            aria-label="Close word details"
            className="details-modal__backdrop"
            type="button"
            onClick={() => setIsDetailsVisible(false)}
          />
          <div className="details-modal__panel">
            <button
              aria-label="Close word details"
              className="details-modal__close"
              type="button"
              onClick={() => setIsDetailsVisible(false)}
            >
              x
            </button>

            <div className="details-modal__header">
              <p className="flashcard__label">Word details</p>
              <h3>{card.answer_en}</h3>
            </div>

            <div className="flashcard-details">
              {card.part_of_speech ? (
                <div>
                  <span>Part of speech</span>
                  <p>{card.part_of_speech}</p>
                </div>
              ) : null}

              {card.definition_en ? (
                <div>
                  <span>Definition in English</span>
                  <p>{card.definition_en}</p>
                </div>
              ) : null}

              {card.main_translations_es?.length ? (
                <div>
                  <span>Main translations</span>
                  <ul>
                    {card.main_translations_es.map((translation) => (
                      <li key={translation}>{translation}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {card.collocations?.length ? (
                <div>
                  <span>Collocations</span>
                  <ul>
                    {card.collocations.map((collocation) => (
                      <li key={collocation}>{collocation}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {card.example_sentence ? (
                <div>
                  <span>Example sentence</span>
                  <p>{card.example_sentence}</p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default Flashcard;
