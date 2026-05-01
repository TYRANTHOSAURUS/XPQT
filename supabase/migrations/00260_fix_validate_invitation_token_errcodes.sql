-- 00260_fix_validate_invitation_token_errcodes.sql
-- Visitor Management v1 — distinct SQLSTATEs for token validation errors.
--
-- Bug fixed:
--   In 00256 all three failure paths used SQLSTATE 'P0001' (the default
--   for `raise_exception`). The API layer had to string-match the message
--   text to distinguish invalid_token / token_already_used / token_expired
--   — fragile and locale-sensitive.
--
-- Fix:
--   Use distinct codes from the application-defined SQLSTATE class '45XXX':
--     invalid_token       -> 45001
--     token_already_used  -> 45002
--     token_expired       -> 45003
--   The MESSAGE text is preserved for human-readable logs; callers should
--   discriminate on errcode.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.7

drop function if exists public.validate_invitation_token(text, text);

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
    raise exception 'invalid_token' using errcode = '45001';
  end if;
  if v_record.used_at is not null then
    raise exception 'token_already_used' using errcode = '45002';
  end if;
  if v_record.expires_at < now() then
    raise exception 'token_expired' using errcode = '45003';
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
  'Anonymous-callable visitor invitation token validator. Single-use, hash-only lookup. Distinct SQLSTATEs (fixed in 00260): 45001 invalid_token / 45002 token_already_used / 45003 token_expired. Used by /visit/cancel/:token endpoint. SECURITY DEFINER; search_path locked.';

notify pgrst, 'reload schema';
