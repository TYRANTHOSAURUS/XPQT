-- 00154_service_rule_templates_path_fix.sql
-- Fix `item_blackout` template predicate path.
--
-- The original seed referenced `$.booking.start_at.day_of_week` — but the
-- predicate engine's resolveRef walks dotted paths against the context
-- object. `start_at` is an ISO string, so `.day_of_week` resolves to
-- undefined and the template never fires.
--
-- The ServiceEvaluationContext pre-derives `start_at_day_of_week` as a
-- sibling field on the `booking` mirror — that's the path templates must use.
--
-- Idempotent: only updates the row if it still has the broken path.

update public.service_rule_templates
set applies_when_template = '{"op":"in","left":{"path":"$.booking.start_at_day_of_week"},"right":{"const":"$.blackout_days"}}'::jsonb
where template_key = 'item_blackout'
  and applies_when_template::text like '%start_at.day_of_week%';

notify pgrst, 'reload schema';
