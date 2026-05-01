-- 00265_peek_invitation_token_function.sql
-- Visitor Management v1 — anonymous-callable, NON-CONSUMING token preview.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.7
-- Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 10
--
-- Why this exists:
--   `validate_invitation_token` is single-use: every successful call marks
--   `used_at = now()` and locks the token to a 1-shot lifetime. That's
--   correct for the cancel ACTION but wrong for the cancel CONFIRMATION
--   page, which needs to render visit details ("You're cancelling your
--   visit on Wed May 7 at HQ Amsterdam") BEFORE the visitor commits.
--
--   `peek_invitation_token` is the read-only sibling:
--     - same hash + purpose lookup
--     - DOES NOT mutate `used_at`
--     - returns the same SQLSTATE shape so the API layer can re-use the
--       error mapping (45001 invalid_token, 45003 token_expired)
--     - intentionally has NO 45002 case — peek is idempotent. A caller can
--       refresh the preview page as many times as they want without ever
--       burning the token.
--     - returns enough denormalized data to render the confirmation
--       interstitial without a second round trip from the frontend:
--         visitor_id, tenant_id, status, first_name,
--         expected_at, expected_until, building_name, host_first_name
--
-- Security:
--   - SECURITY DEFINER + locked search_path, identical to
--     validate_invitation_token. Caller is anonymous; token IS the auth.
--   - Returns visit details only when the token resolves; otherwise raises.
--     A pure existence-check leak (e.g. timing-side-channel on whether a
--     token exists) is unavoidable for any token-based scheme; the threat
--     is acceptable because tokens are 64-char hex.
--   - building_name + host_first_name are denormalized through joins
--     inside the SECURITY DEFINER context. The caller would otherwise have
--     to issue separate queries we can't grant anon access to.

create or replace function public.peek_invitation_token(p_token text, p_purpose text)
  returns table (
    visitor_id        uuid,
    tenant_id         uuid,
    visitor_status    text,
    first_name        text,
    expected_at       timestamptz,
    expected_until    timestamptz,
    building_id       uuid,
    building_name     text,
    host_first_name   text
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_token_hash text := encode(sha256(p_token::bytea), 'hex');
  v_record public.visit_invitation_tokens;
begin
  -- Lookup. NO `for update` and NO mutation — peek is read-only.
  select * into v_record
    from public.visit_invitation_tokens
   where token_hash = v_token_hash
     and purpose = p_purpose;

  if not found then
    raise exception 'invalid_token' using errcode = '45001';
  end if;
  -- Note: we deliberately allow already-used tokens through. The cancel
  -- LANDING page wants to show "your visit was already cancelled" — that
  -- judgement is made at the API layer based on the visitor's status,
  -- not on token consumption. Treating used + expired identically would
  -- prevent the post-cancel "thanks, already cancelled" copy.
  if v_record.expires_at < now() then
    raise exception 'token_expired' using errcode = '45003';
  end if;

  -- Denormalized join — we resolve building_name + primary host
  -- first_name through a single query so the anonymous caller doesn't
  -- need (and shouldn't have) read access to spaces / persons.
  return query
    select
      v.id                                   as visitor_id,
      v.tenant_id                            as tenant_id,
      v.status                               as visitor_status,
      v.first_name                           as first_name,
      v.expected_at                          as expected_at,
      v.expected_until                       as expected_until,
      v.building_id                          as building_id,
      coalesce(s.name, 'the office')         as building_name,
      coalesce(p.first_name, 'your host')    as host_first_name
    from public.visitors v
    left join public.spaces s
      on s.id = v.building_id
     and s.tenant_id = v.tenant_id
    left join public.persons p
      on p.id = v.primary_host_person_id
     and p.tenant_id = v.tenant_id
    where v.id = v_record.visitor_id
      and v.tenant_id = v_record.tenant_id;
end;
$$;

revoke all on function public.peek_invitation_token(text, text) from public;
grant execute on function public.peek_invitation_token(text, text) to anon, authenticated, service_role;

comment on function public.peek_invitation_token(text, text) is
  'Anonymous, NON-CONSUMING preview of a visitor invitation token. Used by /visit/cancel/:token confirmation interstitial. Returns denormalized visit details. SQLSTATEs: 45001 invalid_token / 45003 token_expired. No 45002 — peek is idempotent. Sibling to validate_invitation_token (which is single-use). SECURITY DEFINER; search_path locked.';

notify pgrst, 'reload schema';
