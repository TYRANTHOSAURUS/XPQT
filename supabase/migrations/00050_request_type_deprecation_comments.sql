-- 00050_request_type_deprecation_comments.sql
-- Portal scope slice: mark default_assignment_policy_id deprecated.
-- UI "Linked Routing Rule" field and admin list column "routing_rule_id" are aliases.
-- All three are removed from authored surfaces in this slice; DB column drops in
-- routing-studio plan Workstream G.
-- See docs/portal-scope-slice.md §3.6

comment on column public.request_types.default_assignment_policy_id is
  'DEPRECATED — not authoritative at runtime. UI "Linked Routing Rule" and admin list column "routing_rule_id" are aliases. Removed from authored surfaces in portal-scope slice. Column dropped in routing-studio Workstream G.';
