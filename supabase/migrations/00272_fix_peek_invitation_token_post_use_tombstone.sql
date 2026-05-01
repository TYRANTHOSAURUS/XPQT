-- 00272_fix_peek_invitation_token_post_use_tombstone.sql
-- Visitor Management v1 — full-review fix I12.
--
-- Problem (I12):
--   `peek_invitation_token` (00265) deliberately allows already-used
--   tokens through — the cancel landing page wants to render "your visit
--   was already cancelled" copy without a second round-trip. But it
--   continues to return the FULL denormalized payload (visitor first
--   name, host first name, building name, expected_at, expected_until,
--   visitor status) AFTER the token has been consumed. Anyone who
--   captures the token once can keep scraping that PII indefinitely:
--     - bot brute-forces a token
--     - succeeds (1-in-2^256 per attempt is functionally zero, but a
--       leaked email forward gives a real token)
--     - cancellation gets used at some later point
--     - bot keeps polling the peek endpoint, learns first names + visit
--       schedule for as long as the row exists in
--       `visit_invitation_tokens` (which only `delete on cascade` from
--       visitor delete prunes; until then the row lingers).
--
--   Tokens are bearer auth. The only mitigation we control is to redact
--   PII once the token has been consumed.
--
-- Fix:
--   Recreate `peek_invitation_token` so that AFTER `used_at` is set, the
--   function returns a tombstone row:
--     visitor_id      = the visitor uuid (still useful for the
--                        post-cancel landing page to call into the
--                        `/visit/cancel/:token` POST → which itself will
--                        raise 45002 token_already_used → mapped to a
--                        clean "already cancelled" message).
--     tenant_id       = the tenant uuid (same reason).
--     visitor_status  = 'cancelled' (a fixed sentinel — even if the
--                        underlying row is in a different state, post-use
--                        peek should never reveal it).
--     first_name      = NULL
--     expected_at     = NULL
--     expected_until  = NULL
--     building_id     = NULL
--     building_name   = NULL
--     host_first_name = NULL
--   Pre-use behavior is unchanged.
--
--   The function still raises 45001 invalid_token / 45003 token_expired;
--   45002 (token already used) remains explicitly NOT raised — the cancel
--   landing UX flow expects a row back so it can render a "your visit
--   was already cancelled" message rather than "this link is invalid".
--   The tombstone gives the UX what it needs while leaking nothing.

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
  if v_record.expires_at < now() then
    raise exception 'token_expired' using errcode = '45003';
  end if;

  -- Post-use tombstone: token was already consumed. Return enough to
  -- render the "your visit was already cancelled" UX, but NULL out every
  -- PII field. The token is bearer; if it's been captured we don't keep
  -- handing out the visitor's first name + schedule indefinitely.
  if v_record.used_at is not null then
    return query
      select
        v_record.visitor_id        as visitor_id,
        v_record.tenant_id         as tenant_id,
        'cancelled'::text          as visitor_status,
        null::text                 as first_name,
        null::timestamptz          as expected_at,
        null::timestamptz          as expected_until,
        null::uuid                 as building_id,
        null::text                 as building_name,
        null::text                 as host_first_name;
    return;
  end if;

  -- Pre-use: full denormalized join, identical to migration 00265.
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
  'Anonymous, NON-CONSUMING preview of a visitor invitation token. Used by /visit/cancel/:token confirmation interstitial. PRE-use: returns denormalized visit details. POST-use: returns a tombstone (visitor_status=cancelled, all PII NULL) so the row stops leaking visitor + host first names indefinitely once the token has been consumed (full-review fix I12). SQLSTATEs: 45001 invalid_token / 45003 token_expired. SECURITY DEFINER; search_path locked.';

notify pgrst, 'reload schema';
