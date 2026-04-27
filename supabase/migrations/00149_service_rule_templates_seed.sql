-- 00149_service_rule_templates_seed.sql
-- Seven v1 templates per spec §6.1.
--
-- Idempotent: ON CONFLICT (template_key) DO NOTHING means re-running this
-- migration on remote (or after pnpm db:reset) won't double-seed.

insert into public.service_rule_templates
  (template_key, name, description, category, effect_default, applies_when_template, param_specs, approval_config_template) values

('per_item_lead_time',
 'Per-item lead time enforcement',
 'Warn or require approval when an order is placed inside the lead time window.',
 'capacity',
 'warn',
 '{"op":"<","left":{"path":"$.order.line.lead_time_remaining_hours"},"right":{"const":"$.threshold"}}'::jsonb,
 '[{"key":"threshold","label":"Hours of lead time","type":"number","default":24}]'::jsonb,
 null),

('cost_threshold_approval',
 'Cost threshold approval',
 'Require approval when an order''s per-occurrence total exceeds a threshold.',
 'approval',
 'require_approval',
 '{"op":">","left":{"path":"$.order.total_per_occurrence"},"right":{"const":"$.threshold"}}'::jsonb,
 '[{"key":"threshold","label":"Threshold (currency)","type":"number","default":500}]'::jsonb,
 '{"approver_target":"cost_center.default_approver"}'::jsonb),

('external_vendor_approval',
 'External-vendor approval over threshold',
 'Require approval for orders against external vendors when over a threshold.',
 'approval',
 'require_approval',
 '{"op":"and","args":[{"op":"is_not_null","args":[{"path":"$.line.menu.fulfillment_vendor_id"}]},{"op":">","left":{"path":"$.order.total"},"right":{"const":"$.threshold"}}]}'::jsonb,
 '[{"key":"threshold","label":"Threshold (currency)","type":"number","default":200}]'::jsonb,
 '{"approver_target":"role","role_id":"$.finance_role_id"}'::jsonb),

('cost_center_owner_approval',
 'Cost-center owner approval',
 'Always route to the cost-center default approver. Use for booking categories that need owner sign-off.',
 'approval',
 'require_approval',
 '{"op":"is_not_null","args":[{"path":"$.bundle.cost_center_id"}]}'::jsonb,
 '[]'::jsonb,
 '{"approver_target":"cost_center.default_approver"}'::jsonb),

('item_blackout',
 'Item availability blackout',
 'Deny an item on specific days of week (e.g. "no catering on Mondays").',
 'availability',
 'deny',
 '{"op":"in","left":{"path":"$.booking.start_at_day_of_week"},"right":{"const":"$.blackout_days"}}'::jsonb,
 '[{"key":"blackout_days","label":"Days to block","type":"days_of_week","default":[1]}]'::jsonb,
 null),

('role_restricted_item',
 'Role-restricted item',
 'Deny an item unless the requester has a specific role (e.g. premium catering for execs only).',
 'availability',
 'deny',
 '{"op":"and","args":[{"op":"=","left":{"path":"$.line.catalog_item_id"},"right":{"const":"$.target_item_id"}},{"op":"not","args":[{"op":"contains","left":{"path":"$.requester.role_ids"},"right":{"const":"$.target_role_id"}}]}]}'::jsonb,
 '[{"key":"target_item_id","label":"Item","type":"catalog_item"},{"key":"target_role_id","label":"Required role","type":"role"}]'::jsonb,
 null),

('min_attendee_for_item',
 'Minimum attendees for item',
 'Warn when ordering an item for fewer than the minimum attendees (e.g. catering trays for parties of 6+).',
 'capacity',
 'warn',
 '{"op":"<","left":{"path":"$.line.quantity"},"right":{"const":"$.min"}}'::jsonb,
 '[{"key":"min","label":"Minimum","type":"number","default":6}]'::jsonb,
 null)

on conflict (template_key) do nothing;

notify pgrst, 'reload schema';
