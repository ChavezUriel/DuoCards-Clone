-- Make the public RPCs callable ONLY by the `authenticated` role.
-- Functions are created with EXECUTE granted to PUBLIC; revoking from `anon`
-- alone is not enough because `anon` inherits the PUBLIC grant. Revoke PUBLIC
-- (and anon explicitly) then grant authenticated.
--
-- NOTE: these RPCs remain SECURITY DEFINER on purpose — each enforces ownership
-- via auth.uid() exactly like the old FastAPI `WHERE user_id = ?` checks, and
-- needs to read global (user_id IS NULL) decks and clone them. Supabase's
-- "Signed-In Users Can Execute SECURITY DEFINER Function" advisory therefore
-- remains by design; it is the intended API surface for authenticated users.

do $$
declare
    fn text;
    fns text[] := array[
        'public.get_home_decks()',
        'public.get_market_decks()',
        'public.get_review_card(bigint)',
        'public.get_deck_progress(bigint)',
        'public.get_deck_preview(bigint)',
        'public.submit_review(bigint, text)',
        'public.update_card_visibility(bigint, boolean)',
        'public.update_card(bigint, text, text, text, text, text, text[], text[], text, text, text)',
        'public.update_deck_home_selection(bigint, boolean)',
        'public.update_deck_smart_practice_inclusion(bigint, boolean)',
        'public.start_smart_practice_session(int, int, text, text)',
        'public.get_smart_practice_session(bigint)',
        'public.submit_smart_practice_review(bigint, bigint, text)'
    ];
begin
    foreach fn in array fns loop
        execute format('revoke execute on function %s from public, anon;', fn);
        execute format('grant execute on function %s to authenticated;', fn);
    end loop;
end $$;

notify pgrst, 'reload schema';
