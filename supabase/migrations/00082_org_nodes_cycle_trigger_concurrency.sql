-- 00082_org_nodes_cycle_trigger_concurrency.sql
-- Closes the cycle-prevention race described in the post-ship review of the
-- org-nodes feature: two concurrent UPDATEs re-parenting sibling nodes could
-- each pass the cycle check (each trigger sees the world pre-commit) and
-- together create a cycle.
--
-- Fix: acquire a tenant-scoped advisory lock at the top of the trigger so all
-- INSERT/UPDATE operations on org_nodes within the same tenant serialize.
-- Org-tree edits are rare + admin-only, so the lock contention is negligible.

create or replace function public.enforce_org_node_no_cycle()
returns trigger language plpgsql as $$
declare v_cursor uuid; v_depth int := 0;
begin
  -- Serialize concurrent parent-chain mutations within this tenant so the
  -- walk below sees a consistent snapshot of the tree.
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text, 0));

  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'org_node cannot be its own parent';
  end if;
  v_cursor := new.parent_id;
  while v_cursor is not null and v_depth < 50 loop
    if v_cursor = new.id then
      raise exception 'org_node cycle detected via parent chain';
    end if;
    select parent_id into v_cursor from public.org_nodes where id = v_cursor;
    v_depth := v_depth + 1;
  end loop;
  if v_depth >= 50 then
    raise exception 'org_node tree exceeds max depth of 50';
  end if;
  return new;
end;
$$;
