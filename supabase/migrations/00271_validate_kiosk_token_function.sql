-- 00271_validate_kiosk_token_function.sql
-- Visitor Management v1 — full-review fix I4.
--
-- Problem (I4):
--   `KioskAuthGuard` looks up `public.kiosk_tokens` directly via
--   `db.queryOne(...)`. The table has `revoke all ... from public, anon,
--   authenticated` (migration 00258), which means the only reason that
--   query works today is that DbService connects as the `postgres`
--   superuser and bypasses RLS / privilege checks. Migration 00258's
--   own comment claims "anonymous lookups must go through SECURITY DEFINER"
--   — and yet there is no SECURITY DEFINER function. The current shape is
--   superuser-direct, contradicting the design.
--
-- Fix:
--   This migration adds the missing function. KioskAuthGuard calls it via
--   `select * from public.validate_kiosk_token($1)`. The function:
--     - hashes the input token (sha256)
--     - looks up `kiosk_tokens` by hash + active=true + expires_at > now()
--     - returns one row with (tenant_id, building_id, kiosk_token_id) on
--       hit; raises with a SQLSTATE the API layer can map cleanly on miss
--   Granted to `anon, authenticated, service_role` so a kiosk can validate
--   its bearer token without DbService relying on the postgres superuser
--   privilege escalation. service_role retains direct table access for the
--   admin path that lists/rotates tokens (KioskService).
--
-- SQLSTATEs (mirror the validate_invitation_token convention):
--   45011 — invalid_token  (hash not present at all)
--   45012 — token_inactive (active=false → revoked)
--   45013 — token_expired  (expires_at <= now())
-- The guard maps all three to `401 Unauthorized` with a generic body so
-- we don't leak which condition fired.

create or replace function public.validate_kiosk_token(p_token text)
  returns table (
    tenant_id        uuid,
    building_id      uuid,
    kiosk_token_id   uuid
  )
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_hash text := encode(sha256(p_token::bytea), 'hex');
  v_row  public.kiosk_tokens;
begin
  select * into v_row
    from public.kiosk_tokens
   where token_hash = v_hash;

  if not found then
    raise exception 'invalid_token' using errcode = '45011';
  end if;

  if v_row.active is not true then
    raise exception 'token_inactive' using errcode = '45012';
  end if;

  if v_row.expires_at <= now() then
    raise exception 'token_expired' using errcode = '45013';
  end if;

  return query
    select v_row.tenant_id, v_row.building_id, v_row.id;
end;
$$;

revoke all on function public.validate_kiosk_token(text) from public;
grant execute on function public.validate_kiosk_token(text) to anon, authenticated, service_role;

comment on function public.validate_kiosk_token(text) is
  'Anonymous-callable kiosk bearer-token validation. Returns (tenant_id, building_id, kiosk_token_id) on hit; raises 45011/45012/45013 on miss/inactive/expired. SECURITY DEFINER + locked search_path. Replaces the implicit superuser bypass that KioskAuthGuard relied on (full-review fix I4).';

notify pgrst, 'reload schema';
