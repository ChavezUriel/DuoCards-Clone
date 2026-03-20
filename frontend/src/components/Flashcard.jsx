import { useEffect, useState } from 'react';

function Flashcard({ card, isAnswerVisible, onReveal }) {
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);

  useEffect(() => {
    if (!isAnswerVisible) {
      setIsDetailsVisible(false);
    }
  }, [isAnswerVisible, card.card_id]);

  return (
    <section className="panel flashcard">
      <p className="flashcard__label">Spanish</p>
      <h2>{card.prompt_es}</h2>
      {card.example_es ? <p className="flashcard__example">{card.example_es}</p> : null}

      <div className={`answer ${isAnswerVisible ? 'answer--visible' : ''}`}>
        <p className="flashcard__label">English</p>
        {isAnswerVisible ? (
          <>
            <div className="answer__header">
              <h3>{card.answer_en}</h3>
              <button
                aria-expanded={isDetailsVisible}
                aria-label={isDetailsVisible ? 'Hide word details' : 'Show word details'}
                className="info-button"
                type="button"
                onClick={() => setIsDetailsVisible((current) => !current)}
              >
                i
              </button>
            </div>
            {isDetailsVisible ? (
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
            ) : null}
          </>
        ) : (
          <p>Try to remember the English answer before revealing it.</p>
        )}
      </div>

      <button className="button button--secondary" type="button" onClick={onReveal}>
        {isAnswerVisible ? 'Hide answer' : 'Reveal answer'}
      </button>
    </section>
  );
}

export default Flashcard;
