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
      </div>
      {progress.is_completed ? (
        <p className="review-progress__note">All cards are known. The deck stays open for another round.</p>
      ) : null}
    </aside>
  );
}

export default ProgressSummary;
