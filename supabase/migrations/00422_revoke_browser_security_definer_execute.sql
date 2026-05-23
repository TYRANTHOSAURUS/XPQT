-- 00422 — Browser EXECUTE hardening for app-owned SECURITY DEFINER routines.
--
-- 00417 tried to solve the browser-direct RPC leak by revoking EXECUTE on
-- every public routine. That broke normal browser/PostgREST reads because RLS
-- policies execute helper functions such as current_tenant_id() as the
-- querying role. 00420 correctly restored helper EXECUTE and narrowly blocked
-- the proven tickets_distinct_tags(uuid) leak.
--
-- This migration completes the posture without repeating 00417's mistake:
-- browser roles keep EXECUTE on the RLS/bearer-token allowlist, but lose
-- EXECUTE on every other app-owned SECURITY DEFINER routine. Those functions
-- bypass RLS/table grants and are intended for NestJS service_role/postgres
-- callers or trigger execution, not direct browser RPC.
--
-- Deliberately not a schema-wide/default-privilege blanket revoke. Future RLS
-- helper functions must remain callable by browser roles; the smoke gate owns
-- the "no risky SECURITY DEFINER browser EXECUTE" regression check.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and pg_get_userbyid(p.proowner) = 'postgres'
      and p.prosecdef
      and p.proname not in (
        -- Anonymous/bearer-token flows, reviewed in Audit 04 P2.
        'validate_invitation_token',
        'peek_invitation_token',
        'validate_kiosk_token',
        -- RLS helper used by GDPR policies. Revoking it breaks normal reads.
        'gdpr_caller_has'
      )
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated',
      fn.signature
    );
  end loop;
end $$;

-- Re-assert the allowlist explicitly so the migration is safe after either a
-- fresh reset or a hand-restored remote state.
grant execute on function public.validate_invitation_token(text, text)
  to anon, authenticated;
grant execute on function public.peek_invitation_token(text, text)
  to anon, authenticated;
grant execute on function public.validate_kiosk_token(text)
  to anon, authenticated;
grant execute on function public.gdpr_caller_has(text)
  to anon, authenticated;

-- Preserve the API path for all app-owned SECURITY DEFINER routines.
grant execute on all routines in schema public to service_role;

notify pgrst, 'reload schema';
