-- audit-03 Slice 2 — D-5 edit-scope idempotency producer-determinism.
--
-- (i) WHAT THIS CHANGES. This migration extends the
--     `public.booking_edit_strip_hash_server_fields` hash-exclusion set
--     by TWO additional, NON-`_`-prefixed names: `old_outcome` and
--     `chain_config_changed`. Both are produced by
--     assemble-edit-plan.service.ts:756-761 under each plan's `approval`
--     object and are derived ENTIRELY from a LIVE `approvals` read
--     (`loadCurrentApprovalChain`, edit-plan-helpers.ts:210-313) with
--     ZERO caller input:
--       - `old_outcome`           = currentChain === null ? 'allow'
--                                   : 'require_approval'
--       - `chain_config_changed`  = !chainConfigsEqual(currentChain,
--                                   newChainConfig)
--     A same-intent edit_booking_scope COMMIT mutates `approvals` in its
--     §3.6.5 reconciliation (insert / expire / reject a chain). A
--     legitimate same-intent RETRY under the same idempotency key then
--     re-runs the producer, which reads back the now-mutated live chain
--     → these two fields FLIP → a different post-strip md5 → a spurious
--     `command_operations.payload_mismatch` 409 and the op is
--     permanently lost (audit-03 D-5). These two fields are PURE
--     PRE-STATE: they describe the booking's approval state BEFORE the
--     patch, not the caller's intent, and are fully re-derivable by the
--     RPC from `new_chain_config` + the live chain inside its row lock.
--     This is the SAME class as the existing `_resolution_at` exclusion
--     (a server-stamped, retry-unstable, non-intent field) — it just is
--     not `_`-prefixed, so it must be enumerated explicitly.
--
--     COMPLETENESS-FALSIFIED: a runnable jest guard
--     (assemble-edit-plan.idempotency.spec.ts "GUARD 3") drives the REAL
--     `assembleScopeEditPlan`→`buildSingleSlotPlan` producer path TWICE
--     with `loadCurrentApprovalChain` returning different live-chain
--     state across the two runs (modeling commit→retry, both the
--     no-chain→inserted-chain and chain→expired transitions). It proves
--     the bug under the OLD `{_resolution_at}` set, computes the
--     EXHAUSTIVE deep key-path diff of the two post-`{_resolution_at}`-
--     strip payloads, and asserts the varying set is EXACTLY
--     `{approval.old_outcome, approval.chain_config_changed}` — no third
--     field. The fix is proven under the new 3-name set (md5 identical).
--     The live smoke (apps/api/scripts/smoke-edit-booking-scope.mjs
--     FIXME-409 block) is the AUTHORITATIVE completeness gate over the
--     modeled jest guard; it runs in the batch push pass.
--
-- (ii) FORWARD-ONLY on the shared remote. This is an in-place
--     `create or replace` of the helper; rollback is a follow-up
--     migration (re-`create or replace` with the prior 1-name set).
--     Reverting reinstates the D-5 409. There is no `down`.
--
-- (iii) THE RPC IS UNAFFECTED. `edit_booking` (00407:233/415-447) and
--     `edit_booking_scope` read `->>'old_outcome'` /
--     `->>'chain_config_changed'` from the UNSTRIPPED plan jsonb to
--     drive §3.6.5 reconciliation. This helper only shapes the HASH
--     INPUT (the `command_operations` idempotency key payload), so those
--     reconciliation reads are NOT affected — only the
--     payload_mismatch-detection hash is made retry-stable.
--
-- Reproduction discipline: the function body below is reproduced
-- VERBATIM from the LIVE definition in
-- supabase/migrations/00407_booking_edit_idempotency_intent_hash.sql
-- :55-82 (Read in this session; confirmed no 00408-00427 migration
-- redefines `booking_edit_strip_hash_server_fields` or
-- `booking_edit_idempotency_payload_hash` — only 00411 references the
-- payload-hash NAME in a comment, not a redefinition). The SOLE
-- executable delta vs the live 00407 helper is the `key not in (...)`
-- exclusion list:
--   00407:  where key not in ('_resolution_at')
--   00430:  where key not in ('_resolution_at','old_outcome','chain_config_changed')
-- `language sql immutable`, `set search_path = public`, and the
-- revoke/grant trailer are reproduced verbatim. The
-- `booking_edit_idempotency_payload_hash` wrapper, `edit_booking`, and
-- `edit_booking_scope` are NOT modified — they call this helper by
-- qualified name, so this in-place create-or-replace is picked up.
--
-- COLLISION AUDIT (grep-proven): `old_outcome` and `chain_config_changed`
-- appear as object keys ONLY under `EditPlanApproval`
-- (edit-plan.types.ts:40-57; sole producer assemble-edit-plan.service
-- .ts:756-761) in the entire hashed payload. No other plan field or
-- nested object at any depth uses either name, so this GLOBAL
-- by-exact-name strip removes only the intended
-- `approval.{old_outcome,chain_config_changed}` and cannot
-- collateral-strip an unrelated field.

create or replace function public.booking_edit_strip_hash_server_fields(p_value jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case jsonb_typeof(p_value)
    when 'object' then (
      select coalesce(jsonb_object_agg(key, public.booking_edit_strip_hash_server_fields(value)), '{}'::jsonb)
      from jsonb_each(p_value)
      where key not in ('_resolution_at','old_outcome','chain_config_changed')
    )
    when 'array' then (
      select coalesce(jsonb_agg(public.booking_edit_strip_hash_server_fields(value) order by ord), '[]'::jsonb)
      from jsonb_array_elements(p_value) with ordinality as e(value, ord)
    )
    else p_value
  end
$$;

revoke all on function public.booking_edit_strip_hash_server_fields(jsonb) from public;
grant  execute on function public.booking_edit_strip_hash_server_fields(jsonb) to service_role;

comment on function public.booking_edit_idempotency_payload_hash(jsonb) is
  'Booking-audit remediation Slice 1 + audit-03 Slice 2 (D-5) — deterministic command_operations idempotency hash for edit_booking / edit_booking_scope. Strips, before md5: (1) the server-stamped _-prefixed _resolution_at, and (2) the two pre-state-derived approval fields old_outcome / chain_config_changed (both derived ENTIRELY from a live approvals read the same-intent COMMIT mutates in its §3.6.5 reconciliation; pure pre-state, fully re-derivable by the RPC from new_chain_config + live state — NOT caller intent, the _resolution_at precedent class). Without (2) a legitimate same-intent retry re-read the mutated live chain → those two fields flipped → spurious command_operations.payload_mismatch 409, op permanently lost (audit-03 D-5). The RPC still reads old_outcome / chain_config_changed from the UNSTRIPPED plan so §3.6.5 reconciliation is unaffected. The producer (assemble-edit-plan.service.ts) canonicalises the non-_-prefixed retry-unstable arrays (incl. the now-sorted new_chain_config.required_approvers); this helper covers the _-prefixed server field plus the two enumerated pre-state fields. Completeness-falsified by assemble-edit-plan.idempotency.spec.ts GUARD 3; authoritative live gate = smoke-edit-booking-scope.mjs.';
