# audit-03 D-5 — edit-scope idempotency producer-determinism (DECISION + CLOSE)

Date: 2026-05-18
Slice: audit-03 Slice 2 (deferred-finding closeout)
Status: **CLOSED** (migration `00430` + producer canonical-approver-sort; live smoke is the authoritative completeness gate, validated in the batch push pass)

---

## 1. Finding

`edit_booking` (`p_plan`) and `edit_booking_scope` (`p_plans`) compute their
`command_operations` idempotency `payload_hash` via
`public.booking_edit_idempotency_payload_hash(...)` →
`public.booking_edit_strip_hash_server_fields(...)` (live def:
`00407_booking_edit_idempotency_intent_hash.sql:55-82`; nothing in
00408–00427 redefines it — verified, only 00411 references the *name* in a
comment).

A **same-intent COMMIT→RETRY** of an `edit_booking_scope` (or `edit_booking`)
under the same idempotency key spuriously raised
`command_operations.payload_mismatch` (409), and the op was **permanently
lost** (the gate refuses to re-execute under a mismatching hash).

## 2. Root cause (PROVEN — empirical completeness, not asserted)

The producer `assemble-edit-plan.service.ts` emits, under each plan's
`approval` object (`buildSingleSlotPlan` ~:756-761):

- `old_outcome` = `currentChain === null ? 'allow' : 'require_approval'`
- `chain_config_changed` = `!chainConfigsEqual(currentChain, newChainConfig)`

Both derive **entirely** from `loadCurrentApprovalChain`
(`edit-plan-helpers.ts:210-313`), a LIVE read of the `approvals` table with
**zero caller input**. The COMMIT's RPC §3.6.5 reconciliation **mutates
`approvals`** (insert / expire / reject a chain). The same-intent RETRY
re-runs the producer, which reads back the now-mutated live chain → those
two fields **flip** → a different post-strip md5 → spurious
`command_operations.payload_mismatch` 409.

The strip helper (`booking_edit_strip_hash_server_fields`) recursively
removes any object key whose **exact name** is in a literal set, currently
exactly `('_resolution_at')`, at any depth. It only shapes the **HASH
INPUT**. The RPCs read `->>'old_outcome'` / `->>'chain_config_changed'`
from the **UNSTRIPPED** plan to drive §3.6.5 reconciliation
(`00407` ~:233/:235/:415-447), so excluding them from the hash does **not**
affect reconciliation. No other consumer of these two fields exists
(grep-verified). They are **pure pre-state** — the `_resolution_at`
precedent class.

### Empirical completeness proof (the load-bearing evidence)

A runnable jest guard (`assemble-edit-plan.idempotency.spec.ts` GUARD-3)
drives the **REAL** scope producer path
(`assembleScopeEditPlan`→`buildSingleSlotPlan`) **twice** with mocked
supabase such that `loadCurrentApprovalChain` returns DIFFERENT live-chain
state across the two runs (modeling commit→retry), for BOTH transition
classes:

1. **no-chain → inserted-chain** (post-commit reconciliation created the
   chain): `old_outcome` `allow`→`require_approval`, `chain_config_changed`
   `true`→`false`.
2. **chain → expired/rejected** (the §3.6.5 expire branch): reverse flip.

For each pair the guard:

- **(a)** proves the bug under the CURRENT `{_resolution_at}` strip set —
  `md5(run1) ≠ md5(run2)`. Observed on HEAD:
  `md5(run1)=4cb9047bd2d18f79bdb09951a6a98329`
  `md5(run2)=b337eff8e7ab85a6c00cb011ce3782f6`.
- **(b)** **COMPLETENESS**: computes the **exhaustive deep key-path diff**
  of the two post-`{_resolution_at}`-strip payloads and asserts the varying
  set is **EXACTLY** `{approval.old_outcome, approval.chain_config_changed}`.
  Observed on HEAD for BOTH transitions:
  `post-{_resolution_at}-strip varying key paths =
  ["approval.chain_config_changed","approval.old_outcome"]` — **no third
  field**. The by-name strip set is therefore COMPLETE; this is NOT a third
  misdiagnosis.
- **(c)** proves the fix under the proposed
  `{_resolution_at, old_outcome, chain_config_changed}` set —
  `md5(run1) == md5(run2)` (`d19e23e93fcfd8f66fa913ae0a9b40ba`).

## 3. Two prior misdiagnoses (recorded, history preserved)

D-5 was misdiagnosed twice before this slice (see the 2026-05-17 D-5 row in
`docs/follow-ups/audits/03-booking-reservation.md`, preserved, not
rewritten):

1. **"scope assembler missing Slice-1 array canonicalization"** — wrong:
   scope uses the SAME canonicalized `buildSingleSlotPlan`; the 6 retry-
   unstable arrays were already sorted in Slice 1 (D-2).
2. **"`edit_booking_scope` never adopted the 00407 strip helper; fix =
   one-line hash swap"** — wrong: `00407:1256` shows `edit_booking_scope`
   already routes through `booking_edit_idempotency_payload_hash(p_plans)`;
   two `p_plans` differing only in nested `_resolution_at` empirically hash
   identically. An honest subagent refused to ship the resulting no-op
   migration; no false artifact reached the shared remote.

The fix in this slice was gated behind a **hard completeness-falsification
guard** (STEP 1) precisely to avoid a third misdiagnosis: the migration was
written ONLY after the exhaustive deep key-path diff proved the varying set
is exactly the two pre-state fields.

## 4. The fix

- **Migration `00430_booking_edit_strip_hash_prestate_fields.sql`** — a
  VERBATIM reproduction of the live `00407:55-82`
  `booking_edit_strip_hash_server_fields` body. **Sole executable delta**:
  the exclusion set `('_resolution_at')` →
  `('_resolution_at','old_outcome','chain_config_changed')`.
  `language sql immutable`, `set search_path = public`, and the
  `revoke`/`grant` trailer are reproduced verbatim. The
  `booking_edit_idempotency_payload_hash` wrapper, `edit_booking`, and
  `edit_booking_scope` are NOT modified — they call the helper by qualified
  name, so the in-place `create or replace` is picked up. The
  `comment on function` text is updated to document the two pre-state
  exclusions.

- **Producer canonical approver sort** (STEP 3) —
  `assemble-edit-plan.service.ts` `shapeChainConfigForPlan`: apply
  `canonicalApproverSort` (the SAME comparator `chainConfigsEqual` uses) to
  `required_approvers` before serialisation. This closes a **separate
  latent ≥2-approver order-instability**: the rule-resolver approver
  fan-out has no guaranteed order, so the same logical edit could serialise
  `required_approvers` differently → spurious `payload_mismatch`. The RPC's
  chain insert treats `required_approvers` as a **set, not a sequence**
  (verified in plan review), so canonicalising the order CANNOT change the
  approval decision / threshold / parallel-group — it only makes the hashed
  payload byte-stable.

- **Guards / contract honesty** —
  `assemble-edit-plan.idempotency.spec.ts`: new GUARD-3 (completeness
  falsification + the producer-sort guard); GUARD-2 reworked to assert the
  SQL set == the TS mirror == the exhaustive enumerated set
  `{_resolution_at, old_outcome, chain_config_changed}` (and to ignore SQL
  `--` comments so the migration header's documentation diff doesn't defeat
  the parse); `SERVER_FIELD_EXCLUSIONS` mirror extended. The D-2 documented-
  residual note in `docs/follow-ups/audits/03-booking-reservation.md` is
  updated to record that the two pre-state fields are now explicitly
  enumerated-excluded and GUARD-2 covers them.

## 5. Why excluding from the hash is semantically correct

The idempotency hash exists to detect *a caller resubmitting a DIFFERENT
intent under the same key*. `old_outcome` / `chain_config_changed` are NOT
caller intent — they are **pre-state** describing the booking's approval
state *before* the patch, derived 100% from a live DB read with zero
caller input, mutated by the very COMMIT whose RETRY this guards. They are
fully **re-derivable by the RPC** from `new_chain_config` + the live chain
inside its row lock. Hashing them makes a same-intent retry non-idempotent
for no semantic gain — exactly the `_resolution_at` precedent. Critically,
the RPC still reads them from the **UNSTRIPPED** plan, so §3.6.5
reconciliation behaviour is **byte-identical** to pre-fix; only the
payload-mismatch-detection hash is made retry-stable.

### Collision audit (grep-proven)

`old_outcome` and `chain_config_changed` appear as object keys ONLY under
`EditPlanApproval` (`edit-plan.types.ts:40-57`; sole producer
`assemble-edit-plan.service.ts:756-761`) in the entire hashed payload. No
other plan field or nested object at any depth uses either name, so the
SQL helper's GLOBAL by-exact-name strip removes only the intended
`approval.{old_outcome,chain_config_changed}` and cannot collateral-strip
an unrelated field.

## 6. Residuals

- **Forward-only on the shared remote.** `00430` is an in-place
  `create or replace`; rollback is a follow-up migration (re-`create or
  replace` with the prior 1-name set). Reverting reinstates the D-5 409.
  There is no `down`.
- **General drift residual narrowed, not eliminated.** GUARD-2 now covers
  the D-5 pair explicitly. A FUTURE, currently-unknown non-`_`
  request-varying field NOT yet enumerated remains the same general drift
  class (it would require a new completeness falsification + enumeration).
  The D-5 pair specifically is closed.
- **D-6 (attach-services lead-time)** is the SAME root class but a
  DIFFERENT producer (`buildAttachPlan`/`hydrateLines` bakes a
  `Date.now()`-derived `lead_time_remaining_hours` into the resolver
  context). It is NOT fixed here (different RPC, different producer, the
  nondeterminism is in the rule OUTCOME not a raw field) — see the D-6 row
  + `slice5-attach-services-decision.md` §D-6. Bundled owner remains the
  producer-determinism slice for D-6.

## 7. Authoritative completeness gate

The modeled jest GUARD-3 models the producer with mocked supabase. The
**authoritative** live completeness gate is the
`apps/api/scripts/smoke-edit-booking-scope.mjs` probe (the former
FIXME-409 block, now flipped to assert idempotent cached-success replay):
it exercises a REAL same-intent `edit_booking_scope` COMMIT→RETRY against
the running server + real DB, where the COMMIT's §3.6.5 reconciliation
genuinely mutates `approvals`. It is authoritative OVER the jest guard and
is validated in the **audit-03 batch push pass** once `00430` is on remote
(the orchestrator runs live smokes; this slice does not push).

## 8. Verification (this slice, pre-push)

- `pnpm -s --filter @prequest/api exec tsc --noEmit` — clean (exit 0).
- `pnpm -s --filter @prequest/api exec jest src/modules/reservations` —
  264 passed, **4 failed** (the pre-existing
  `reservation-edit-scope.spec.ts` failures from the parallel
  splitSeries-signature workstream; proven pre-existing by stashing this
  slice's changes and re-running — unchanged at 4, NOT caused here). All 5
  `assemble-edit-plan.idempotency.spec.ts` tests pass post-fix.
- `pnpm -s errors:check-app-errors` — clean (0 raw throws across 35
  migrated modules).
- Live smokes NOT run (orchestrator runs them in the batch push pass).
