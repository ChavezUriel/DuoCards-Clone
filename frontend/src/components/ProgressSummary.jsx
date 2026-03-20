function ProgressSummary({ progress }) {
  const percentage = progress.total_cards === 0 ? 0 : Math.round(progress.completion_ratio * 100);

  return (
    <aside className="panel progress-summary">
      <p className="deck-card__label">Progress</p>
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${percentage}%` }} />
      </div>
      <dl>
        <div>
          <dt>Total cards</dt>
          <dd>{progress.total_cards}</dd>
        </div>
        <div>
          <dt>Reviewed</dt>
          <dd>{progress.reviewed_cards}</dd>
        </div>
        <div>
          <dt>Known</dt>
          <dd>{progress.known_cards}</dd>
        </div>
        <div>
          <dt>Need review</dt>
          <dd>{progress.unknown_cards}</dd>
        </div>
      </dl>
      {progress.is_completed ? (
        <p className="progress-summary__note">This deck is fully known, but it stays available for another practice round.</p>
      ) : null}
    </aside>
  );
}

export default ProgressSummary;
