function ProgressSummary({ progress }) {
  const percentage = progress.total_cards === 0 ? 0 : Math.round(progress.completion_ratio * 100);

  return (
    <aside className="review-progress" aria-label="Deck progress">
      <div className="review-progress__track" aria-hidden="true">
        <div className="review-progress__fill" style={{ width: `${percentage}%` }} />
      </div>
      <div className="review-progress__meta">
        <span>{progress.reviewed_cards} of {progress.total_cards} reviewed</span>
        <span>{progress.known_cards} known</span>
        <span>{progress.unknown_cards} to revisit</span>
        {progress.is_completed ? <span className="review-progress__status">Practice anytime</span> : null}
      </div>
    </aside>
  );
}

export default ProgressSummary;
