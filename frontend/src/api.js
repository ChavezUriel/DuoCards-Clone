const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
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
