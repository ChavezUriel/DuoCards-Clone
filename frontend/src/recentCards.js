// A small rolling pool of recently *seen* practice cards, persisted to
// localStorage. The session snapshot only ever exposes one `current_card` at a
// time, so a warm-up interstitial — which runs *before* the first card of a
// session (docs/minigames.md §6.1) — has no in-session pool to draw from. Keeping
// the last few words the user studied lets the warm-up genuinely "re-activate
// prior words" across sessions. Only the fields a boundary game needs are stored,
// and the list is capped, so the blob stays tiny. See the Phase 3 open decision on
// the card pool (no backend change).
const STORAGE_KEY = 'duocards.recentPracticeCards';
const CAP = 24;

function slimCard(card) {
  if (!card || card.card_id == null) {
    return null;
  }
  const prompt_es = (card.prompt_es ?? '').trim();
  const answer_en = (card.answer_en ?? '').trim();
  if (!prompt_es || !answer_en) {
    return null;
  }
  return { card_id: card.card_id, prompt_es, answer_en, section_name: card.section_name ?? null };
}

export function loadRecentCards() {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(slimCard).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Newest-first, de-duped by card_id, capped. An incoming card supersedes any
// older copy of the same card, keeping its position fresh.
export function mergeRecentCards(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const card of [...(incoming ?? []), ...(existing ?? [])]) {
    const slim = slimCard(card);
    if (!slim || seen.has(slim.card_id)) {
      continue;
    }
    seen.add(slim.card_id);
    merged.push(slim);
    if (merged.length >= CAP) {
      break;
    }
  }
  return merged;
}

export function saveRecentCards(cards) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify((cards ?? []).slice(0, CAP)));
  } catch {
    /* storage full or unavailable — the warm-up pool is best-effort */
  }
}
