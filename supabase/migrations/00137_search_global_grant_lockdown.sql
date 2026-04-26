-- Tighten search_global RPC grants ------------------------------------------
--
-- Previous migration granted execute to authenticated/anon for symmetry with
-- other RPCs. That's unsafe here: the RPC takes (p_user_id, p_tenant_id) as
-- arguments and trusts both — meaning any authenticated user across any
-- tenant could call PostgREST directly with another tenant's id and read
-- across tenant boundaries.
--
-- The web app only ever reaches this RPC through /api/search, which resolves
-- the caller to (user_id, tenant_id) on the server before invoking it via
-- the service-role client. So service_role is the only role that should be
-- able to execute it.

revoke execute on function public.search_global(uuid, uuid, text, text[], int)
  from authenticated, anon, public;

-- service_role keeps execute (it always did via the grant in 00136).

notify pgrst, 'reload schema';
