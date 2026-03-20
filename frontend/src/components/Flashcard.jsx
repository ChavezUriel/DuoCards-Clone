import { useEffect, useState } from 'react';

function Flashcard({ card, isAnswerVisible, onReveal }) {
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [isAnswerVisible, card.card_id]);

  return (
    <>
      <section className="panel flashcard">
        <div className="flashcard__face flashcard__face--front">
          <p className="flashcard__label">Spanish</p>
          <h2>{card.prompt_es}</h2>
          {card.example_es ? <p className="flashcard__example">{card.example_es}</p> : null}
        </div>

        <div className={`answer ${isAnswerVisible ? 'answer--visible' : ''}`}>
          <p className="flashcard__label">English</p>
          {isAnswerVisible ? (
            <div className="answer__content">
              <div className="answer__header">
                <h3>{card.answer_en}</h3>
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
