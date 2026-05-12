-- B.4.A.5 sub-step A · 00392 · notification_template_overrides
--
-- Per-tenant per-locale partial-text overrides for notification template
-- copy (subject, CTA text, body intro). Default React Email components
-- live in apps/api/src/modules/notifications/templates/ (sub-step C).
-- Empty-string override fields fall back to default at render time
-- (architect I5 — see /tmp/b4a5-plan-v2.md §Sub-step C).
--
-- Citations (verified in current main):
--   - supabase/migrations/00002_rls_helpers.sql:5-14
--       public.current_tenant_id().
--   - supabase/migrations/00003_people_users_roles.sql:35-46
--       public.users (id, tenant_id, auth_uid).
--   - supabase/migrations/00109_permissions_wildcards.sql:42-84
--       public.user_has_permission(p_user_id uuid, p_tenant_id uuid,
--       p_permission text). Note 3-arg signature — plan v2 line 103
--       wrote `user_has_permission(auth.uid(), '...')` which would fail
--       both on arg count and arg type (auth.uid() = supabase auth uuid,
--       NOT users.id). Corrected here via the canonical bridge below.
--   - supabase/migrations/00167_gdpr_rls_hardening.sql:31-37
--       Canonical RLS bridge (auth.uid → users.auth_uid → users.id).
--   - supabase/migrations/00244_vendor_status_events_realtime.sql:46-59
--       Inline-bridge composite policy pattern (used here verbatim).
--   - packages/shared/src/permissions.ts:374-384
--       notifications.manage_templates already registered in the
--       permission catalog — no new key invented.
--
-- Why no DB audit trigger here (despite plan v2 line 107-109 prescribing
-- one): public.audit_event_from_row() does NOT exist in this codebase.
-- Audit writes are TS-layer inserts via supabase.admin.from('audit_events')
-- (e.g. apps/api/src/modules/tenant/branding.service.ts:226 — admin-config
-- write, exactly the shape of this table). The notifications admin service
-- (sub-step G) emits the audit row from TS, mirroring branding.service.ts.
-- Documented gap so a follow-up can either add a generic audit trigger
-- helper to the codebase or wire the TS audit write in sub-step G.

create table if not exists public.notification_template_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_kind text not null,
  locale text not null check (locale in ('en','nl')),
  subject_override text null,
  cta_text_override text null,
  body_intro_override text null,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid null references public.users(id),
  unique (tenant_id, event_kind, locale)
);

comment on table public.notification_template_overrides is
  'Per-tenant per-locale partial overrides for notification copy. Empty-string overrides fall back to default template at render time. Audited at the TS layer in NotificationTemplateService (sub-step G).';
comment on column public.notification_template_overrides.event_kind is
  'Matches inbox_notifications.event_kind (e.g. booking.approval_required). Same key drives template lookup + outbox handler dispatch.';
comment on column public.notification_template_overrides.subject_override is
  'When non-null and non-empty, replaces the default subject for this (tenant, event, locale). NULL or "" → use default.';
comment on column public.notification_template_overrides.cta_text_override is
  'When non-null and non-empty, replaces the default CTA button text. NULL or "" → use default.';
comment on column public.notification_template_overrides.body_intro_override is
  'When non-null and non-empty, replaces the default body intro paragraph. NULL or "" → use default.';

-- Touch updated_at on UPDATE — reuse the canonical helper from 00002.
drop trigger if exists set_notification_template_overrides_updated_at
  on public.notification_template_overrides;
create trigger set_notification_template_overrides_updated_at
  before update on public.notification_template_overrides
  for each row execute function public.set_updated_at();

alter table public.notification_template_overrides enable row level security;

-- READ: any tenant member may read the active override set (powers the
-- admin UI's "is this tenant customised?" indicator + the runtime
-- template resolver in sub-step C). Defense-in-depth: tenant scope is
-- enforced; PostgREST + the API's RLS-aware client gate the cross-
-- tenant boundary.
drop policy if exists tenant_read on public.notification_template_overrides;
create policy tenant_read on public.notification_template_overrides
  for select using (
    auth.role() = 'service_role'
    or tenant_id = public.current_tenant_id()
  );

-- WRITE (insert / update / delete): bridge auth.uid → users.id within
-- the JWT tenant, then check user_has_permission(users.id, tenant_id,
-- 'notifications.manage_templates'). Service-role bypasses for the
-- API admin client.
drop policy if exists permission_write on public.notification_template_overrides;
create policy permission_write on public.notification_template_overrides
  for all using (
    auth.role() = 'service_role'
    or (
      tenant_id = public.current_tenant_id()
      and exists (
        select 1
          from public.users u
         where u.tenant_id = public.current_tenant_id()
           and u.auth_uid  = auth.uid()
           and public.user_has_permission(u.id, u.tenant_id, 'notifications.manage_templates')
      )
    )
  )
  with check (
    auth.role() = 'service_role'
    or (
      tenant_id = public.current_tenant_id()
      and exists (
        select 1
          from public.users u
         where u.tenant_id = public.current_tenant_id()
           and u.auth_uid  = auth.uid()
           and public.user_has_permission(u.id, u.tenant_id, 'notifications.manage_templates')
      )
    )
  );

notify pgrst, 'reload schema';
