-- 00150_service_rule_templates_rls_fix.sql
-- The service_rule_templates table holds tenant-agnostic seed data that the
-- admin UI needs to read globally. Supabase's `ensure_rls` event trigger
-- auto-enables RLS on every new table, so we need an explicit
-- "everyone can read" policy here. Without it the seed appears to land
-- (count from postgres role = 7) but every authenticated query returns 0.
--
-- This is the only template-style table in the project that needs a
-- permissive read policy. Mirror this pattern for any future seed tables.

create policy "service_rule_templates_read_all"
  on public.service_rule_templates
  for select
  using (true);

notify pgrst, 'reload schema';
