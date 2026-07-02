import { supabase } from './supabaseClient';

// ---------------------------------------------------------------------------
// Internal helper: call a Postgres RPC and unwrap the result / error.
// Every endpoint of the old FastAPI backend is now a SECURITY DEFINER RPC that
// returns the same JSON shape the frontend already consumed.
// ---------------------------------------------------------------------------
async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    throw new Error(error.message || 'Request failed');
  }
  return data;
}

// ===========================================================================
// Auth (Supabase Auth)
// ===========================================================================
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return data;
}

export async function register(email, fullName, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: window.location.origin,
    },
  });
  if (error) throw new Error(error.message);
  return data; // { user, session } — session is null when email confirmation is required
}

export async function loginWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) throw new Error(error.message);
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function fetchMe() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const user = data.user;
  if (!user) throw new Error('Not authenticated');
  return {
    id: user.id,
    email: user.email,
    full_name: user.user_metadata?.full_name || 'User',
  };
}

// ===========================================================================
// Decks
// ===========================================================================
export function fetchDecks() {
  return rpc('get_home_decks');
}

export function fetchHomeDecks() {
  return rpc('get_home_decks');
}

export function fetchMarketDecks() {
  return rpc('get_market_decks');
}

export function updateDeckSmartPracticeInclusion(deckId, isEnabledInSmartPractice) {
  return rpc('update_deck_smart_practice_inclusion', {
    p_deck_id: deckId,
    p_is_enabled_in_smart_practice: isEnabledInSmartPractice,
  });
}

export function updateDeckHomeSelection(deckId, isSelectedOnHome) {
  return rpc('update_deck_home_selection', {
    p_deck_id: deckId,
    p_is_selected_on_home: isSelectedOnHome,
  });
}

export function fetchReviewCard(deckId) {
  return rpc('get_review_card', { p_deck_id: deckId });
}

export function submitReview(cardId, result) {
  return rpc('submit_review', { p_card_id: cardId, p_result: result });
}

export function fetchDeckProgress(deckId) {
  return rpc('get_deck_progress', { p_deck_id: deckId });
}

export function fetchDeckPreview(deckId) {
  return rpc('get_deck_preview', { p_deck_id: deckId });
}

// ===========================================================================
// Cards
// ===========================================================================
export function updateCardVisibility(cardId, isEnabled) {
  return rpc('update_card_visibility', { p_card_id: cardId, p_is_enabled: isEnabled });
}

export function updateCard(cardId, payload) {
  return rpc('update_card', {
    p_card_id: cardId,
    p_prompt_es: payload.prompt_es,
    p_answer_en: payload.answer_en,
    p_section_name: payload.section_name ?? null,
    p_part_of_speech: payload.part_of_speech ?? null,
    p_definition_en: payload.definition_en ?? null,
    p_main_translations_es: payload.main_translations_es ?? [],
    p_collocations: payload.collocations ?? [],
    p_example_sentence: payload.example_sentence ?? null,
    p_example_es: payload.example_es ?? null,
    p_example_en: payload.example_en ?? null,
    p_mnemonic_en: payload.mnemonic_en ?? null,
  });
}

// ===========================================================================
// Spaced repetition
// ===========================================================================
export function fetchDueSummary() {
  return rpc('get_due_summary');
}

// ===========================================================================
// Smart practice
// ===========================================================================
export function startSmartPracticeSession(settings = {}) {
  return rpc('start_smart_practice_session', {
    p_new_block_size: settings.new_block_size ?? 7,
    p_review_batch_size: settings.review_batch_size ?? 30,
    p_interleaving_intensity: settings.interleaving_intensity ?? 'medium',
    p_focus_mode: settings.focus_mode ?? 'auto',
  });
}

export function getSmartPracticeSession(sessionId) {
  return rpc('get_smart_practice_session', { p_session_id: sessionId });
}

export function submitSmartPracticeReview(sessionId, cardId, result) {
  return rpc('submit_smart_practice_review', {
    p_session_id: sessionId,
    p_card_id: cardId,
    p_result: result,
  });
}
