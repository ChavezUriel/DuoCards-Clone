const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

async function request(path, options = {}, baseUrl = API_BASE_URL) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.detail || 'Request failed';
    throw new Error(message);
  }

  return response.json();
}

export function fetchDecks() {
  return request('/api/decks');
}

export function fetchHomeDecks() {
  return request('/api/decks');
}

export function fetchMarketDecks() {
  return request('/api/decks/market');
}

export function updateDeckSmartPracticeInclusion(deckId, isEnabledInSmartPractice) {
  return request(`/api/decks/${deckId}/smart-practice-inclusion`, {
    method: 'PATCH',
    body: JSON.stringify({ is_enabled_in_smart_practice: isEnabledInSmartPractice }),
  });
}

export function updateDeckHomeSelection(deckId, isSelectedOnHome) {
  return request(`/api/decks/${deckId}/home-selection`, {
    method: 'PATCH',
    body: JSON.stringify({ is_selected_on_home: isSelectedOnHome }),
  });
}

export function fetchReviewCard(deckId) {
  return request(`/api/decks/${deckId}/review`);
}

export function submitReview(cardId, result) {
  return request('/api/reviews', {
    method: 'POST',
    body: JSON.stringify({ card_id: cardId, result }),
  });
}

export function fetchDeckProgress(deckId) {
  return request(`/api/decks/${deckId}/progress`);
}

export function fetchDeckPreview(deckId) {
  return request(`/api/decks/${deckId}/preview`);
}

export function updateCardVisibility(cardId, isEnabled) {
  return request(`/api/cards/${cardId}/visibility`, {
    method: 'PATCH',
    body: JSON.stringify({ is_enabled: isEnabled }),
  });
}

export function updateCard(cardId, payload) {
  return request(`/api/cards/${cardId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function startSmartPracticeSession(settings) {
  return request('/api/practice/sessions', {
    method: 'POST',
    body: JSON.stringify({ settings }),
  });
}

export function submitSmartPracticeReview(sessionId, cardId, result) {
  return request(`/api/practice/sessions/${sessionId}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ card_id: cardId, result }),
  });
}
