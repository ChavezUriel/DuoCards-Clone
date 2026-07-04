export const DEFAULT_PRACTICE_SETTINGS = {
  new_block_size: 7,
  review_batch_size: 30,
  interleaving_intensity: 'medium',
  focus_mode: 'auto',
  minigames: {
    enabled: true,
    // How often games replace/wrap the classic swipe: 'off' | 'light' | 'balanced' | 'heavy'.
    frequency: 'balanced',
    // One entry per game, added as each rollout phase ships one. An empty map
    // means every card falls back to the classic flashcard (today's behavior).
    games: {
      // Phase 1 (Tier A — counts toward scheduling): type the English for a
      // Spanish prompt. See docs/minigames.md §4 (#1) and §9 Phase 1.
      type_translation: true,
      // Phase 2 (Tier B — practice only): pick the English translation from a
      // few options. A clean wrong pick records a lapse; a correct pick advances
      // without grading, so it never inflates the schedule. On by default per the
      // plan's example (docs/minigames.md §7.1, §11.4); §4 (#4), §9 Phase 2.
      multiple_choice: true,
      // Phase 3 (Tier C — practice only): queue-external boundary games that only
      // ever run as interstitials (warm-up / block boundary / cool-down) and never
      // touch the schedule. On by default per the plan's example (docs/minigames.md
      // §7.1); memory_grid = §4 (#8), speed_round = §4 (#7), §9 Phase 3.
      memory_grid: true,
      speed_round: true,
    },
  },
};

const STORAGE_KEY = 'duocards.smartPracticeSettings';

// Overlay a stored blob onto the defaults. Top-level keys are a shallow merge,
// but `minigames` (and its nested `games` map) is merged one level deeper so a
// blob written by an older app version still inherits games added since — see
// docs/minigames.md §7.1.
function mergePracticeSettings(overrides) {
  const storedMinigames =
    overrides && typeof overrides.minigames === 'object' && overrides.minigames ? overrides.minigames : {};

  return {
    ...DEFAULT_PRACTICE_SETTINGS,
    ...overrides,
    minigames: {
      ...DEFAULT_PRACTICE_SETTINGS.minigames,
      ...storedMinigames,
      games: {
        ...DEFAULT_PRACTICE_SETTINGS.minigames.games,
        ...(storedMinigames.games ?? {}),
      },
    },
  };
}

export function loadPracticeSettings() {
  if (typeof window === 'undefined') {
    return DEFAULT_PRACTICE_SETTINGS;
  }

  const rawValue = window.localStorage.getItem(STORAGE_KEY);
  if (!rawValue) {
    return DEFAULT_PRACTICE_SETTINGS;
  }

  try {
    const parsedValue = JSON.parse(rawValue);
    return mergePracticeSettings(parsedValue);
  } catch {
    return DEFAULT_PRACTICE_SETTINGS;
  }
}

export function savePracticeSettings(settings) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}