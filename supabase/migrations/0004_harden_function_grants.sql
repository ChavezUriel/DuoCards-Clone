-- Security hardening for the RPC layer (addresses Supabase advisors).
--
-- 1. Pin search_path on the one helper that was missing it.
-- 2. Internal helpers (prefixed `_`) and the auth trigger function must NOT be
--    callable from the REST API at all — revoke from anon, authenticated, public.
--    They only ever run inside SECURITY DEFINER call chains (as the owner) or as
--    a trigger, so revoking client EXECUTE does not affect the app.
-- 3. Public-facing RPCs stay SECURITY DEFINER (they enforce ownership via
--    auth.uid(), mirroring the old FastAPI checks) but are restricted to the
--    `authenticated` role; `anon` cannot call them.

alter function public._norm_text_items(text[]) set search_path = '';

-- (2) Lock down helpers + trigger function.
revoke execute on function public._norm_text_items(text[]) from anon, authenticated, public;
revoke execute on function public._review_card_json(bigint) from anon, authenticated, public;
revoke execute on function public._preview_card_json(bigint) from anon, authenticated, public;
revoke execute on function public._apply_card_progress(bigint, uuid, text) from anon, authenticated, public;
revoke execute on function public._clear_pending_practice_cards_for_deck(bigint) from anon, authenticated, public;
revoke execute on function public._duplicate_base_deck_to_user(bigint, uuid) from anon, authenticated, public;
revoke execute on function public._practice_session_snapshot(bigint, uuid) from anon, authenticated, public;
revoke execute on function public._choose_session_mode(uuid, int, text) from anon, authenticated, public;
revoke execute on function public.handle_new_user() from anon, authenticated, public;

-- (3) Public RPCs: revoke from anon, keep authenticated.
revoke execute on function public.get_home_decks() from anon;
revoke execute on function public.get_market_decks() from anon;
revoke execute on function public.get_review_card(bigint) from anon;
revoke execute on function public.get_deck_progress(bigint) from anon;
revoke execute on function public.get_deck_preview(bigint) from anon;
revoke execute on function public.submit_review(bigint, text) from anon;
revoke execute on function public.update_card_visibility(bigint, boolean) from anon;
revoke execute on function public.update_card(bigint, text, text, text, text, text, text[], text[], text, text, text) from anon;
revoke execute on function public.update_deck_home_selection(bigint, boolean) from anon;
revoke execute on function public.update_deck_smart_practice_inclusion(bigint, boolean) from anon;
revoke execute on function public.start_smart_practice_session(int, int, text, text) from anon;
revoke execute on function public.get_smart_practice_session(bigint) from anon;
revoke execute on function public.submit_smart_practice_review(bigint, bigint, text) from anon;

notify pgrst, 'reload schema';
