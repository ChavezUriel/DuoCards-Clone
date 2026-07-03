-- Account management: let a signed-in user delete their own account.
-- Every app table references auth.users with ON DELETE CASCADE (see 0001),
-- so deleting the auth user removes profiles, decks, cards, card_progress
-- and practice sessions in one statement.

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := (select auth.uid());
begin
    if current_user_id is null then
        raise exception 'Not authenticated';
    end if;

    delete from auth.users where id = current_user_id;
end;
$$;

-- Same hardening as 0005: EXECUTE is granted to PUBLIC on creation; strip it
-- and allow only authenticated users.
revoke execute on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

notify pgrst, 'reload schema';
