-- 00098_drop_rt_form_schema_id.sql
-- Resolve codex's open fork (b): request_types.form_schema_id vs
-- request_type_form_variants as dual sources of truth for the default form.
-- The variant table already drives portal submission and the catalog/trace
-- paths; the request_types column only survived so the old RT admin dialog
-- could set "a form" in one place. After Phase E (no mirror triggers), the
-- column is just a legacy alias that the app had to keep in sync manually.
--
-- Drop it. Admins set the default form variant via
-- PUT /request-types/:id/form-variants; the dialog writes there directly.

alter table public.request_types drop column if exists form_schema_id;

notify pgrst, 'reload schema';
