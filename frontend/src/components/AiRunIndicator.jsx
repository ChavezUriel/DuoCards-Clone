import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getLiveJob, runningJobIds, subscribeToRuns } from '../ai/runManager';
import { jobProgress } from '../ai/generator';

// A deck run keeps going while the learner browses the rest of the app, so the
// header carries a live link back to it — otherwise the only way back is the
// browser's history.
function AiRunIndicator() {
  const [runIds, setRunIds] = useState(() => runningJobIds());

  useEffect(() => subscribeToRuns(() => setRunIds(runningJobIds())), []);

  if (runIds.length === 0) return null;

  const jobId = runIds[0];
  const job = getLiveJob(jobId);
  const progress = job ? jobProgress(job) : null;

  return (
    <Link className="ai-run-pill" to={`/decks/runs/${jobId}`}>
      <span className="ai-run-pill__dot" aria-hidden="true" />
      {progress ? `Generating ${progress.done}/${progress.total}` : 'Generating'}
      {runIds.length > 1 ? ` +${runIds.length - 1}` : ''}
    </Link>
  );
}

export default AiRunIndicator;
