-- Booking-audit remediation Slice 4 — atomic, idempotent recurrence split.
--
-- Closes audit `docs/follow-ups/audits/03-booking-reservation.md` P1-2:
--   `RecurrenceService.splitSeries` was 3 separate non-atomic supabase-js
--   writes ((1) INSERT recurrence_series, (2) UPDATE forward bookings,
--   (3) UPDATE source series) + a swallowed best-effort audit_events
--   insert, with NO actor + NO idempotency. A crash between writes 1 and 2
--   leaves an orphan recurrence_series whose id no occurrence references;
--   a retry of the surrounding editScope minted a SECOND orphan series
--   (the TS `skipSplitSeries` pre-check was a brittle hack papering over
--   the non-idempotency — see reservation.service.ts:1696-1743 pre-fix).
--
-- Replaces the non-atomic TS choreography
-- (a7570f14-era recurrence.service.ts:754-864 splitSeries) with ONE
-- PL/pgSQL transaction, mirroring the canonical
-- `cancel_booking_with_cascade` (00408) / `edit_booking` (00407) pattern:
-- command_operations idempotency gate, F-CRIT-1 actor block, advisory
-- lock, in-tx (NOT swallowed) audit_events.
--
-- ── Citation discipline ──────────────────────────────────────────────────
-- Every pattern reproduced below was Read in this session:
--   - 00408_cancel_booking_with_cascade.sql:101-648 — the LIVE canonical
--     template: F-CRIT-1 actor resolution (`where u.auth_uid =
--     p_actor_user_id and u.tenant_id = p_tenant_id`; raise
--     `<rpc>.actor_not_found` if null AND p_actor_user_id was non-null),
--     command_operations gate (plain deterministic md5 over the arg tuple
--     — NO server-stamped field so NO booking_edit_idempotency_payload_hash
--     strip helper; cache-hit return cached_result; payload-mismatch raise
--     P0001; unexpected_state raise; insert in_progress), pivot FOR UPDATE
--     + tenant validation, lock-then-aggregate FOR UPDATE ordered by id
--     (deadlock-safe), in-tx audit_events (no longer swallowed),
--     revoke/grant + security definer + search_path trailer.
--   - 00407_booking_edit_idempotency_intent_hash.sql — the advisory-lock
--     ON THE IDEMPOTENCY KEY shape (edit RPC serializes per request, not
--     per booking). split runs INSIDE editScope and must serialize per
--     editScope's idempotency key, so this RPC uses the
--     idempotency-key lock shape (NOT 00408's per-booking shape).
--   - recurrence.service.ts:807-825 — the EXACT column set the legacy
--     splitSeries copied into the new recurrence_series row: tenant_id,
--     recurrence_rule, series_start_at := pivot.start_at, series_end_at
--     (copied from source), max_occurrences, holiday_calendar_id,
--     materialized_through, parent_booking_id := pivot.id.
--   - 00124_recurrence_series.sql:5-17 — recurrence_series base schema
--     (id, tenant_id, recurrence_rule jsonb, series_start_at,
--     series_end_at, max_occurrences int default 365, holiday_calendar_id,
--     materialized_through, parent_reservation_id, created_at, updated_at).
--   - 00278_retarget_sibling_tables.sql:175-184 — parent_reservation_id
--     was RENAMED to parent_booking_id (FK now → public.bookings(id)).
--   - 00277_create_canonical_booking_schema.sql — bookings has
--     recurrence_series_id + start_at + tenant_id (the forward-set
--     predicate columns).
--   - 00316_command_operations_table.sql — command_operations columns
--     (tenant_id, idempotency_key, payload_hash, outcome enum
--     in_progress|success, cached_result, completed_at).
--   - 00019_events_audit.sql — audit_events
--     (tenant_id, event_type, entity_type, entity_id, actor_user_id,
--     details jsonb).
--
-- ── No outbox emit — explicit deferral (NOT silent) ──────────────────────
-- The legacy splitSeries emitted NO outbox event (only the swallowed
-- audit_events insert). A repo-wide grep for `recurrence.series_split` /
-- `series_split` consumers returned ZERO non-test hits. Emitting an
-- outbox event with no registered handler is speculative — it would sit
-- forever in the outbox with no consumer. This RPC therefore emits NO
-- outbox event; the in-tx `audit_events` row (no longer best-effort,
-- no longer swallowed) is the durable record. If a downstream consumer
-- (calendar resync, reporting reconciliation) ever materialises, add the
-- emit THEN — tracked as an explicit deferral in
-- `docs/follow-ups/slice4-split-recurrence-decision.md` (owner =
-- booking-audit workstream). This mirrors the brief's instruction and
-- the cancel-checklist honesty discipline: no silent omission.
--
-- ── Net behavioral changes (documented, intentional) ─────────────────────
--   - splitSeries becomes atomic: the 3 writes + the audit are ONE tx.
--     A crash rolls everything back — no orphan recurrence_series.
--   - splitSeries becomes command_operations-idempotent. A retry of the
--     same editScope (same bookingId + same clientRequestId) re-calls
--     this RPC with the SAME idempotency key → cache-hit → returns the
--     SAME new_series_id, no second/orphan series minted. This makes the
--     TS `skipSplitSeries` pre-check (reservation.service.ts:1696-1743)
--     OBSOLETE — it is removed in the same change.
--   - The swallowed `try { audit } catch {}` is replaced by an in-tx
--     audit_events insert that participates in the transaction.
--   - F-CRIT-1: p_actor_user_id is auth_uid (Slice-1 D-1 lesson); the
--     wrapper passes actor.auth_uid. p_actor_user_id MAY be null for
--     system/synthetic callers (the recurrence cron has no JWT subject) —
--     handled exactly like 00408: skip the lookup when null; the audit
--     row's actor_user_id is then null.

-- ── split_recurrence_series ──────────────────────────────────────────────

drop function if exists public.split_recurrence_series(uuid, uuid, uuid, text);

create or replace function public.split_recurrence_series(
  p_booking_id      uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, outbox
as $$
declare
  v_started_at      constant timestamptz := now();

  v_existing        public.command_operations;
  v_payload_hash    text;

  v_actor_users_id  uuid;

  v_pivot           record;
  v_src             record;
  v_new_series_id   uuid;
  v_forward_count   int := 0;
  v_row_count       int;

  v_result          jsonb;
begin
  -- ── 0. Argument shape checks (mirror 00408:155-165) ──────────────────
  if p_tenant_id is null then
    raise exception 'split_recurrence_series: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'split_recurrence_series: p_booking_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'split_recurrence_series: p_idempotency_key required';
  end if;

  -- ── 1. F-CRIT-1: auth_uid → users.id ONCE (00408:180-194) ────────────
  -- p_actor_user_id may be null for system/synthetic callers (recurrence
  -- cron has no JWT subject). Skip the lookup when null; the audit row's
  -- actor_user_id is then null (same posture as 00408).
  if p_actor_user_id is not null then
    select u.id
      into v_actor_users_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;

    if v_actor_users_id is null then
      raise exception 'split_recurrence_series.actor_not_found: auth_uid=% not registered as a user in tenant=%',
        p_actor_user_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 2. Advisory lock keyed on (tenant, idempotency_key) ──────────────
  -- split runs INSIDE editScope and must serialize per editScope's
  -- request, not per booking. Mirrors 00407's lock-on-idempotency-key
  -- shape (NOT 00408's per-booking shape). A concurrent retry with the
  -- SAME idempotency key serializes here; the command_operations gate
  -- then short-circuits the loser to the cached result.
  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0));

  -- ── 3. command_operations idempotency gate (00408:205-239) ───────────
  -- The split payload tuple is fully deterministic (no server-stamped
  -- field), so a plain md5 over the canonical arg string is the hash —
  -- the booking-edit strip helper is NOT needed (it targets EditPlan
  -- jsonb, not this tuple).
  v_payload_hash := md5(
    coalesce(p_booking_id::text, '') || '|' ||
    coalesce(p_tenant_id::text, '')  || '|' ||
    coalesce(p_actor_user_id::text, ''));

  select * into v_existing
    from public.command_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      return v_existing.cached_result;
    elsif v_existing.payload_hash <> v_payload_hash then
      raise exception 'command_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload';
    else
      raise exception 'command_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.command_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 4. Lock the pivot booking + tenant validation (00408:241-252) ────
  select id, tenant_id, start_at, recurrence_series_id
    into v_pivot
    from public.bookings
   where id = p_booking_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'split_recurrence_series.not_found: booking=% tenant=%', p_booking_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  if v_pivot.recurrence_series_id is null then
    raise exception 'split_recurrence_series.not_recurring: booking=% is not part of a recurring series', p_booking_id
      using errcode = 'P0001';
  end if;

  -- ── 5. Lock the source recurrence_series FOR UPDATE ──────────────────
  select id, tenant_id, recurrence_rule, series_end_at, max_occurrences,
         holiday_calendar_id, materialized_through
    into v_src
    from public.recurrence_series
   where id = v_pivot.recurrence_series_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'split_recurrence_series.not_found: recurrence_series=% tenant=%',
      v_pivot.recurrence_series_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 6. Lock the forward booking set (deadlock-safe id order) ─────────
  -- Acquire the row locks deterministically before the UPDATE (same
  -- lock-then-mutate ordering rationale as 00408:317-324).
  perform b.id
     from public.bookings b
    where b.tenant_id = p_tenant_id
      and b.recurrence_series_id = v_src.id
      and b.start_at >= v_pivot.start_at
    order by b.id
    for update;

  -- ── 7. The 3 writes, ONE TX (the function body IS the tx) ────────────
  -- 7.a — INSERT the new recurrence_series anchored at the pivot. Column
  --       set is byte-equivalent to the legacy splitSeries insert
  --       (recurrence.service.ts:808-819): tenant_id, recurrence_rule,
  --       series_start_at := pivot.start_at, series_end_at (copied from
  --       source), max_occurrences, holiday_calendar_id,
  --       materialized_through, parent_booking_id := pivot.id
  --       (00278:179-181 renamed from parent_reservation_id).
  insert into public.recurrence_series
    (tenant_id, recurrence_rule, series_start_at, series_end_at,
     max_occurrences, holiday_calendar_id, materialized_through,
     parent_booking_id)
  values
    (p_tenant_id, v_src.recurrence_rule, v_pivot.start_at, v_src.series_end_at,
     v_src.max_occurrences, v_src.holiday_calendar_id, v_src.materialized_through,
     v_pivot.id)
  returning id into v_new_series_id;

  -- 7.b — Move the pivot + all later occurrence bookings onto the new
  --       series id. Tenant-filtered on the write (defense-in-depth even
  --       though the predicate is already tenant-derived — the
  --       tenant-on-write rule from 00408:419-421).
  update public.bookings
     set recurrence_series_id = v_new_series_id
   where tenant_id = p_tenant_id
     and recurrence_series_id = v_src.id
     and start_at >= v_pivot.start_at;
  get diagnostics v_row_count = row_count;
  v_forward_count := v_row_count;

  -- 7.c — Cap the source series so the rollover job won't re-materialise
  --       occurrences past the pivot (legacy: recurrence.service.ts:
  --       840-844). Tenant + id filtered.
  update public.recurrence_series
     set series_end_at = v_pivot.start_at
   where tenant_id = p_tenant_id
     and id = v_src.id;

  -- ── 8. In-tx audit_events (NOT swallowed, NOT best-effort) ───────────
  -- Replaces the legacy `try { audit } catch {}` swallow
  -- (recurrence.service.ts:849-861). Now participates in the tx — if
  -- the audit insert fails the whole split rolls back. Event/entity
  -- shape mirrors the legacy payload + 00408's in-tx audit posture.
  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
  values
    (p_tenant_id, 'booking.recurrence_split', 'recurrence_series',
     v_src.id, v_actor_users_id,
     jsonb_build_object(
       'pivot_booking_id', v_pivot.id,
       'pivot_start_at',   v_pivot.start_at,
       'new_series_id',    v_new_series_id,
       'forward_count',    v_forward_count));

  -- ── 9. Finalize command_operations + return (00408:618-637) ──────────
  v_result := jsonb_build_object(
    'new_series_id',     v_new_series_id,
    'source_series_id',  v_src.id,
    'forward_count',     v_forward_count,
    'pivot_booking_id',  v_pivot.id);

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = v_started_at
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

-- Trailer — mirrors 00408:641-643 (revoke/grant posture).
revoke all on function public.split_recurrence_series(uuid, uuid, uuid, text) from public;
grant  execute on function public.split_recurrence_series(uuid, uuid, uuid, text) to service_role;

comment on function public.split_recurrence_series(uuid, uuid, uuid, text) is
  'Booking-audit remediation Slice 4 (audit 03 P1-2). Atomic, idempotent recurrence split: in ONE tx INSERTs a new recurrence_series anchored at the pivot booking (column set mirrors the legacy splitSeries), moves the pivot + all later occurrence bookings onto the new series, caps the source series at the pivot start, and writes an in-tx (no longer swallowed) audit_events booking.recurrence_split row. command_operations idempotency-gated (00408 pattern) — a retry of the same editScope returns the same new_series_id with no orphan series. F-CRIT-1 actor resolved via auth_uid (null allowed for system callers). Advisory lock on (tenant, idempotency_key) — split serializes per editScope request. NO outbox emit by design (zero consumers of recurrence.series_split; explicit deferral in docs/follow-ups/slice4-split-recurrence-decision.md).';

notify pgrst, 'reload schema';
