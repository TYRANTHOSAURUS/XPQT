-- 00078_teams_add_org_node_id.sql
-- Teams may optionally be attached to an org node for categorization.
-- Does NOT cause team members to inherit the node's location grants.
-- See spec §3.4.

alter table public.teams
  add column org_node_id uuid references public.org_nodes(id) on delete set null;

create index idx_teams_org_node on public.teams (org_node_id);
