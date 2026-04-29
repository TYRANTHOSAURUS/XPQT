-- 00193_service_rules_internal_setup.sql
-- Adds the "requires internal setup" outcome to service rules, enabling
-- auto-creation of internal work orders from order lines. See
-- docs/superpowers/plans/2026-04-29-fulfillment-fixes-wave2.md (Slice 2).
--
-- A service rule today emits an effect (deny / require_approval / warn /
-- allow_override / allow) — that's about whether the order can proceed.
-- This adds an ORTHOGONAL signal: "this line also requires internal
-- facilities-team setup work alongside the vendor delivery." It's a
-- separate field, not a new effect, because a line can be (allowed AND
-- needs setup) at the same time. See plan §"why a separate field."
--
-- internal_setup_lead_time_minutes overrides the location_service_routing
-- (00194) default for this specific rule — admins can say "for THIS
-- rule, setup must complete 60min before service window" and that wins
-- over the location's 30min default. Null = use the matrix default.

alter table public.service_rules
  add column if not exists requires_internal_setup boolean not null default false,
  add column if not exists internal_setup_lead_time_minutes int;

-- A rule only declares "needs setup" — the routing (which team, default
-- lead time, SLA policy) lives in 00194's location_service_routing matrix.
-- This keeps the rule layer focused on "when" and the matrix on "who."

comment on column public.service_rules.requires_internal_setup is
  'When true, an order line that matches this rule will trigger auto-creation of an internal setup work order. The routing (team, lead time, SLA) is resolved via location_service_routing (00194).';

comment on column public.service_rules.internal_setup_lead_time_minutes is
  'Override for the lead time used by this rule. NULL = use location_service_routing default. Useful for high-touch rules ("for VIP catering, setup 90min before").';

notify pgrst, 'reload schema';
