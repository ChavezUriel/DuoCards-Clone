-- ===========================================================================
-- 0016: Recognise password sign-in on OAuth-first accounts & allow unlinking.
--
-- Bug: the Sign-in & security UI inferred "has a password" from the presence of
-- an `email` row in auth.identities. But Supabase/GoTrue does NOT create an
-- `email` identity when a Google-first user sets a password via
-- updateUser({ password }) — it only writes auth.users.encrypted_password. Such
-- users therefore looked password-less, and because GoTrue refuses to unlink an
-- identity unless the account keeps >= 2 identities, they could never unlink
-- Google (their only identity), even with a working password.
--
-- Two SECURITY DEFINER helpers, same hardening pattern as delete_account (0009):
--   * has_password()          — reliable read of encrypted_password for the UI.
--   * ensure_email_identity() — backfill the missing `email` identity (and add
--                               'email' to app_metadata.providers) so the
--                               account matches a native email+password user and
--                               GoTrue's >= 2-identity unlink rule is satisfied.
--
-- Assumes the modern auth.identities shape (provider_id text + surrogate uuid
-- id, unique on (provider_id, provider)); on that schema an email identity has
-- provider_id = user.id::text and identity_data.sub = user.id::text, exactly as
-- GoTrue writes for a native email signup.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- has_password(): true when the current user has a password set.
-- ---------------------------------------------------------------------------
create or replace function public.has_password()
returns boolean
language sql
security definer
set search_path = ''
as $$
    select coalesce(
        (
            select u.encrypted_password is not null and u.encrypted_password <> ''
            from auth.users u
            where u.id = (select auth.uid())
        ),
        false
    );
$$;

revoke execute on function public.has_password() from public, anon;
grant execute on function public.has_password() to authenticated;

-- ---------------------------------------------------------------------------
-- ensure_email_identity(): if the current user has a password but no `email`
-- identity, create one and record 'email' in app_metadata.providers. Idempotent
-- (safe to call repeatedly). Returns true when the user ends up with a usable
-- password + email identity, false when there is nothing to back-fill.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_email_identity()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id   uuid := (select auth.uid());
    v_email     text;
    v_has_pw    boolean;
    v_providers jsonb;
begin
    if v_user_id is null then
        raise exception 'Not authenticated';
    end if;

    select u.email,
           (u.encrypted_password is not null and u.encrypted_password <> '')
      into v_email, v_has_pw
      from auth.users u
     where u.id = v_user_id;

    -- Only back-fill for users who actually have a password and a known email.
    if not coalesce(v_has_pw, false) or v_email is null then
        return false;
    end if;

    -- Create the email identity if it is missing. The unique (provider_id,
    -- provider) constraint makes this a no-op when it already exists.
    insert into auth.identities (
        provider_id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
    )
    values (
        v_user_id::text,
        v_user_id,
        jsonb_build_object(
            'sub', v_user_id::text,
            'email', v_email,
            'email_verified', true,
            'phone_verified', false
        ),
        'email',
        now(), now(), now()
    )
    on conflict (provider_id, provider) do nothing;

    -- Add 'email' to app_metadata.providers so the account state matches a
    -- native email+password user (GoTrue itself keeps this list in sync).
    select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
      into v_providers
      from (
          select jsonb_array_elements_text(
                     coalesce(u.raw_app_meta_data -> 'providers', '[]'::jsonb)
                 ) as value
          from auth.users u
          where u.id = v_user_id
          union
          select 'email'
      ) merged;

    update auth.users u
       set raw_app_meta_data =
               coalesce(u.raw_app_meta_data, '{}'::jsonb)
               || jsonb_build_object('providers', v_providers)
     where u.id = v_user_id;

    return true;
end;
$$;

revoke execute on function public.ensure_email_identity() from public, anon;
grant execute on function public.ensure_email_identity() to authenticated;

notify pgrst, 'reload schema';
