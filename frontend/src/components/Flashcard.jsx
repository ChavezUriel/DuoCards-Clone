function Flashcard({ card, isAnswerVisible, onReveal }) {
  return (
    <section className="panel flashcard">
      <p className="flashcard__label">Spanish</p>
      <h2>{card.prompt_es}</h2>
      {card.example_es ? <p className="flashcard__example">{card.example_es}</p> : null}

      <div className={`answer ${isAnswerVisible ? 'answer--visible' : ''}`}>
        <p className="flashcard__label">English</p>
        {isAnswerVisible ? (
          <>
            <h3>{card.answer_en}</h3>
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
            {card.example_en ? <p className="flashcard__example">{card.example_en}</p> : null}
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
