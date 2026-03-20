export const DEFAULT_PRACTICE_SETTINGS = {
  new_block_size: 7,
  review_batch_size: 30,
  interleaving_intensity: 'medium',
  focus_mode: 'auto',
};

const STORAGE_KEY = 'duocards.smartPracticeSettings';

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
    return {
      ...DEFAULT_PRACTICE_SETTINGS,
      ...parsedValue,
    };
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