-- 00256_validate_invitation_token_function.sql
-- Visitor Management v1 — anonymous-callable token validation.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.7
--
-- Visitors click the cancel link from the invite email unauthenticated. RLS
-- via current_tenant_id() is unusable; this SECURITY DEFINER function:
--   1. Hashes the plaintext token (sha256, hex-encoded — matches the format
--      used when issuing the token in InvitationService).
--   2. Locks the matching visit_invitation_tokens row FOR UPDATE.
--   3. Raises distinct, machine-readable exceptions:
--        invalid_token / token_already_used / token_expired
--   4. Marks the row used_at = now() on success (single-use enforcement).
--   5. Returns (visitor_id, tenant_id) so the caller can act on the visitor.
--
-- Search path is locked to public, pg_temp to prevent search_path attacks.
-- Execute is granted to anon + authenticated; revoked from PUBLIC.

create or replace function public.validate_invitation_token(p_token text, p_purpose text)
  returns table (visitor_id uuid, tenant_id uuid)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_token_hash text := encode(sha256(p_token::bytea), 'hex');
  v_record public.visit_invitation_tokens;
begin
  -- Single-use enforcement: lock the row, fail if already used or expired.
  select * into v_record
    from public.visit_invitation_tokens
   where token_hash = v_token_hash
     and purpose = p_purpose
   for update;

  if not found then
    raise exception 'invalid_token' using errcode = 'P0001';
  end if;
  if v_record.used_at is not null then
    raise exception 'token_already_used' using errcode = 'P0001';
  end if;
  if v_record.expires_at < now() then
    raise exception 'token_expired' using errcode = 'P0001';
  end if;

  -- Consume.
  update public.visit_invitation_tokens
     set used_at = now()
   where id = v_record.id;

  return query select v_record.visitor_id, v_record.tenant_id;
end;
$$;

revoke all on function public.validate_invitation_token(text, text) from public;
grant execute on function public.validate_invitation_token(text, text) to anon, authenticated, service_role;

comment on function public.validate_invitation_token(text, text) is
  'Anonymous-callable visitor invitation token validator. Single-use, hash-only lookup, raises invalid_token | token_already_used | token_expired. Used by /visit/cancel/:token endpoint. SECURITY DEFINER; search_path locked.';

notify pgrst, 'reload schema';
