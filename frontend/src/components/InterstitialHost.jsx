import { useEffect } from 'react';
import MemoryGrid from './MemoryGrid';
import SpeedRound from './SpeedRound';
import WordScramble from './WordScramble';
import Hangman from './Hangman';

// Framing copy per placement (docs/minigames.md §6.1). The game itself is chosen
// upstream by chooseInterstitialGame so the host stays a thin shell.
const PLACEMENT_COPY = {
  warmup: { eyebrow: 'Warm-up' },
  boundary: { eyebrow: 'Quick break' },
  cooldown: { eyebrow: 'Cool-down' },
};

// Render the chosen game. Pool-based games (memory_grid / speed_round) take the
// whole sampled pool; single-card cool-down puzzles (scramble / hangman, §4 #9–#10)
// take just the first card of the pool.
function renderGame(game, cards, onDone) {
  if (game === 'memory_grid') {
    return <MemoryGrid cards={cards} onDone={onDone} />;
  }
  if (game === 'scramble') {
    return <WordScramble card={cards[0]} onDone={onDone} />;
  }
  if (game === 'hangman') {
    return <Hangman card={cards[0]} onDone={onDone} />;
  }
  return <SpeedRound cards={cards} onDone={onDone} />;
}

// Renders a queue-external Tier-C interstitial: a warm-up before the first card,
// a break at a block boundary, or a cool-down on the complete screen. It resolves
// entirely locally — the games never call a session RPC (§5.2, §8.2) — and reports
// back only through onDone(). While it is mounted, PracticePage keeps its classic
// arrow / idle-hint handlers inert (§8.4); the host owns Escape-to-dismiss and the
// games own the rest of the keyboard.
function InterstitialHost({ placement, game, cards, onDone }) {
  const copy = PLACEMENT_COPY[placement] ?? PLACEMENT_COPY.cooldown;

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onDone();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDone]);

  return (
    <div className="interstitial">
      <div className="interstitial__banner">
        <div className="interstitial__intro">
          <p className="eyebrow">{copy.eyebrow}</p>
          <p className="interstitial__note">Just for fun — this never changes your schedule.</p>
        </div>
        <button type="button" className="st-link-button interstitial__skip" onClick={onDone}>
          Skip
        </button>
      </div>

      <div className="interstitial__game">
        {renderGame(game, cards, onDone)}
      </div>
    </div>
  );
}

export default InterstitialHost;
