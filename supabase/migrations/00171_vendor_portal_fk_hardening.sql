-- Vendor Portal Phase B · Sprint 1 hardening (codex review fixes)
--
-- Two cross-tenant integrity gaps from the codex review:
--   1. vendor_users.(tenant_id, vendor_id) are independent FKs — nothing
--      prevents tenant A from creating a vendor_user that points at a
--      vendor in tenant B.
--   2. vendor_user_sessions duplicates tenant_id / vendor_id columns
--      with no composite FK back to vendor_users — repair scripts or a
--      bad write could mint a session into the wrong scope.
--
-- This migration locks both chains down with composite foreign keys.

-- =====================================================================
-- 1. Composite uniqueness on vendors so child rows can FK on (tenant, id)
-- =====================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vendors_tenant_id_uk'
  ) then
    alter table public.vendors
      add constraint vendors_tenant_id_uk unique (tenant_id, id);
  end if;
end
$$;

-- =====================================================================
-- 2. vendor_users(tenant_id, vendor_id) → vendors(tenant_id, id)
-- =====================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vendor_users_tenant_vendor_fk'
  ) then
    -- Drop the old single-column FKs first if present; the composite FK
    -- supersedes both. We keep the columns themselves (queries depend on
    -- the redundancy for performance).
    alter table public.vendor_users
      drop constraint if exists vendor_users_tenant_id_fkey,
      drop constraint if exists vendor_users_vendor_id_fkey;

    alter table public.vendor_users
      add constraint vendor_users_tenant_vendor_fk
        foreign key (tenant_id, vendor_id)
        references public.vendors (tenant_id, id)
        on delete cascade;
  end if;
end
$$;

-- =====================================================================
-- 3. vendor_user_sessions(vendor_user_id, tenant_id, vendor_id)
--    →  vendor_users(id, tenant_id, vendor_id)
-- =====================================================================
-- Sessions can't drift away from their vendor_user's scope. Need a
-- composite uniqueness on vendor_users first.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vendor_users_id_scope_uk'
  ) then
    alter table public.vendor_users
      add constraint vendor_users_id_scope_uk
        unique (id, tenant_id, vendor_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vendor_user_sessions_scope_fk'
  ) then
    alter table public.vendor_user_sessions
      drop constraint if exists vendor_user_sessions_vendor_user_id_fkey;

    alter table public.vendor_user_sessions
      add constraint vendor_user_sessions_scope_fk
        foreign key (vendor_user_id, tenant_id, vendor_id)
        references public.vendor_users (id, tenant_id, vendor_id)
        on delete cascade;
  end if;
end
$$;

-- =====================================================================
-- 4. Same composite FK on vendor_user_magic_links
-- =====================================================================
-- Magic links are scoped via vendor_user_id alone today (no tenant_id
-- column). The cascade-on-delete from vendor_users still works; no
-- additional FK needed here.

notify pgrst, 'reload schema';
