-- Service-rule template fixes — codex Sprint 1B round-1 review caught
-- two seeded templates that compile to broken state:
--
-- 1. external_vendor_approval: approval_config_template references
--    `$.finance_role_id`, but that param is not declared in
--    param_specs. The compiler intentionally leaves unknown $.<key>
--    strings unchanged, so the resolver later treats the literal
--    `$.finance_role_id` as the role id. Fix: add `finance_role_id`
--    to the template's param_specs (type 'role', required).
--
-- 2. role_restricted_item: param `target_role_id` is type 'role'.
--    The frontend's role-type input now renders a SINGLE-role picker
--    (codex round-1 fix); the template's predicate expects a single
--    role id literal. No SQL change needed — the form layer fix
--    in service-rule-template-params-form.tsx covers this.
--
-- Idempotent: jsonb_set is a no-op when the value is already there.

update public.service_rule_templates
   set param_specs = jsonb_set(
     param_specs,
     '{1}',
     '{"key":"finance_role_id","label":"Finance approver role","type":"role","required":true}'::jsonb,
     true
   )
 where template_key = 'external_vendor_approval'
   and not exists (
     select 1
       from jsonb_array_elements(param_specs) e
      where e->>'key' = 'finance_role_id'
   );

-- Also flag every existing param_spec entry with `required` if it isn't
-- already set so the frontend can branch on the optional/required line
-- consistently. The seed used schema-by-omission (no `required` field
-- meant required by default); make that explicit.
update public.service_rule_templates t
   set param_specs = (
     select jsonb_agg(
       case when e ? 'required' then e
            else e || '{"required":true}'::jsonb end
     )
       from jsonb_array_elements(t.param_specs) e
   )
 where exists (
   select 1
     from jsonb_array_elements(t.param_specs) e
    where not (e ? 'required')
 );

notify pgrst, 'reload schema';
