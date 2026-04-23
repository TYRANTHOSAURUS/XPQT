-- 00093_predicates_perf_fix.sql
-- Phase B / service-catalog collapse (2026-04-23) — codex Phase B review fixes.
-- Two issues flagged:
--   1. request_type_audience_rules is indexed (tenant_id, request_type_id, mode, active)
--      but hot predicates scan by (tenant_id, mode, active) with no bound
--      request_type_id. Stranded columns → tenant-wide scans as tenant grows.
--   2. request_type_visible_ids and request_type_offering_matches call
--      expand_space_closure(array[c.space_id]) inside a row filter — per-row
--      recursive downward walks against every candidate coverage rule.
--      For a fixed p_selected_space_id the correct shape is to walk ancestors
--      ONCE and check c.space_id = any(ancestors).

-- ── 1. Audience index aimed at the mode-first scan ────────────────────────
create index if not exists idx_rt_audience_tenant_mode_active
  on public.request_type_audience_rules (tenant_id, mode, active, request_type_id);

-- ── 2a. request_type_offering_matches: ancestor-once coverage check ───────
create or replace function public.request_type_offering_matches(
  p_request_type_id uuid,
  p_selected_space_id uuid,
  p_tenant_id uuid
) returns table (
  id uuid,
  scope_kind text,
  space_id uuid,
  space_group_id uuid,
  created_at timestamptz
) language sql stable as $$
  with recursive ancestors(id, depth) as (
    select p_selected_space_id, 0
    where p_selected_space_id is not null
    union all
    select s.parent_id, a.depth + 1
    from public.spaces s
    join ancestors a on s.id = a.id
    where a.depth < 20 and s.parent_id is not null and s.tenant_id = p_tenant_id
  ),
  ancestor_ids as (
    select id from ancestors where id is not null
  )
  select c.id, c.scope_kind, c.space_id, c.space_group_id, c.created_at
  from public.request_type_coverage_rules c
  where c.tenant_id = p_tenant_id
    and c.request_type_id = p_request_type_id
    and c.active = true
    and (c.starts_at is null or c.starts_at <= now())
    and (c.ends_at   is null or c.ends_at   >  now())
    and (
      c.scope_kind = 'tenant'
      or (
        c.scope_kind = 'space'
        and p_selected_space_id is not null
        and (
          (c.inherit_to_descendants = true  and c.space_id in (select id from ancestor_ids))
          or (c.inherit_to_descendants = false and c.space_id = p_selected_space_id)
        )
      )
      or (
        c.scope_kind = 'space_group'
        and p_selected_space_id is not null
        and exists (
          select 1 from public.space_group_members m
          where m.space_group_id = c.space_group_id
            and m.space_id = p_selected_space_id
        )
      )
    );
$$;

-- ── 2b. request_type_visible_ids: same ancestor-once CTE + grouped audience ──
-- Also collapses four separate audience subqueries into one aggregate per
-- request_type so we walk request_type_audience_rules once per call instead of
-- four times, and read through the (tenant_id, mode, active) index.
create or replace function public.request_type_visible_ids(
  p_actor_person_id uuid,
  p_selected_space_id uuid,
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  with recursive ancestors(id, depth) as (
    select p_selected_space_id, 0
    where p_selected_space_id is not null
    union all
    select s.parent_id, a.depth + 1
    from public.spaces s
    join ancestors a on s.id = a.id
    where a.depth < 20 and s.parent_id is not null and s.tenant_id = p_tenant_id
  ),
  ancestor_ids as (select id from ancestors where id is not null),
  coverage_match as (
    select distinct c.request_type_id as id
    from public.request_type_coverage_rules c
    where c.tenant_id = p_tenant_id and c.active = true
      and (c.starts_at is null or c.starts_at <= now())
      and (c.ends_at   is null or c.ends_at   >  now())
      and (
        c.scope_kind = 'tenant'
        or (
          c.scope_kind = 'space'
          and p_selected_space_id is not null
          and (
            (c.inherit_to_descendants = true  and c.space_id in (select id from ancestor_ids))
            or (c.inherit_to_descendants = false and c.space_id = p_selected_space_id)
          )
        )
        or (
          c.scope_kind = 'space_group'
          and p_selected_space_id is not null
          and exists (
            select 1 from public.space_group_members m
            where m.space_group_id = c.space_group_id and m.space_id = p_selected_space_id
          )
        )
      )
  ),
  -- One pass over the mode-first index instead of four separate scans.
  audience_summary as (
    select a.request_type_id,
           bool_or(a.mode = 'visible_allow') as has_visible_allow,
           bool_or(a.mode = 'visible_allow'
                   and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id))
             as visible_allow_hit,
           bool_or(a.mode = 'visible_deny'
                   and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id))
             as visible_deny_hit
    from public.request_type_audience_rules a
    where a.tenant_id = p_tenant_id
      and a.active = true
      and a.mode in ('visible_allow','visible_deny')
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
    group by a.request_type_id
  )
  select rt.id
  from public.request_types rt
  where rt.tenant_id = p_tenant_id
    and rt.active = true
    and rt.id in (select id from coverage_match)
    and not exists (
      select 1 from audience_summary s
      where s.request_type_id = rt.id
        and (
          s.visible_deny_hit
          or (s.has_visible_allow and not s.visible_allow_hit)
        )
    );
$$;

-- ── 2c. request_type_onboardable_space_ids: same grouped-audience pass ────
-- The outer scan over sites/buildings + per-row expand_space_closure is left
-- as-is (site/building count is small — dozens, not thousands — and the walk
-- is naturally bounded). The audience check is rewritten to use the single
-- (tenant_id, mode, active) read instead of four separate scans.
create or replace function public.request_type_onboardable_space_ids(
  p_tenant_id uuid,
  p_actor_person_id uuid
) returns setof uuid language sql stable as $$
  with audience_summary as (
    select a.request_type_id,
           bool_or(a.mode = 'visible_allow') as has_visible_allow,
           bool_or(a.mode = 'visible_allow'
                   and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id))
             as visible_allow_hit,
           bool_or(a.mode = 'visible_deny'
                   and public.criteria_matches(a.criteria_set_id, p_actor_person_id, p_tenant_id))
             as visible_deny_hit
    from public.request_type_audience_rules a
    where a.tenant_id = p_tenant_id
      and a.active = true
      and a.mode in ('visible_allow','visible_deny')
      and (a.starts_at is null or a.starts_at <= now())
      and (a.ends_at   is null or a.ends_at   >  now())
    group by a.request_type_id
  )
  select distinct s.id
  from public.spaces s
  where s.tenant_id = p_tenant_id
    and s.active = true
    and s.type in ('site','building')
    and exists (
      select 1 from public.request_types rt
      where rt.tenant_id = p_tenant_id and rt.active = true
        and exists (
          select 1 from public.request_type_coverage_rules c
          where c.request_type_id = rt.id and c.tenant_id = p_tenant_id and c.active = true
            and (c.starts_at is null or c.starts_at <= now())
            and (c.ends_at   is null or c.ends_at   >  now())
            and (
              c.scope_kind = 'tenant'
              or (c.scope_kind = 'space' and (
                (c.inherit_to_descendants
                  and s.id in (select * from public.expand_space_closure(array[c.space_id])))
                or (not c.inherit_to_descendants and c.space_id = s.id)
              ))
              or (c.scope_kind = 'space_group' and exists (
                select 1 from public.space_group_members m
                where m.space_group_id = c.space_group_id and m.space_id = s.id
              ))
            )
        )
        and not exists (
          select 1 from audience_summary asm
          where asm.request_type_id = rt.id
            and (
              asm.visible_deny_hit
              or (asm.has_visible_allow and not asm.visible_allow_hit)
            )
        )
    );
$$;

notify pgrst, 'reload schema';
