# Slice 4 (atomic idempotent recurrence split) — design decisions + residuals

Booking-audit remediation Slice 4 (audit `docs/follow-ups/audits/03-booking-reservation.md`
P1-2). Mirrors the honesty/structure of
`docs/follow-ups/slice3-multiroom-validator-decision.md` and
`docs/follow-ups/cancel-booking-equivalence-checklist.md`: every
non-obvious decision and every accepted residual is enumerated
EXPLICITLY — none is silent.

## 1. The problem (audit 03 P1-2)

`RecurrenceService.splitSeries(bookingId)` (pre-Slice-4 body,
recurrence.service.ts:754-864) was 3 separate, non-atomic supabase-js
writes plus a swallowed best-effort audit, with NO actor + NO
idempotency:

1. `INSERT recurrence_series` — new uuid, copies
   recurrence_rule / series_end_at / max_occurrences /
   holiday_calendar_id / materialized_through from the source;
   series_start_at = pivot.start_at; parent_booking_id = pivot.id.
2. `UPDATE bookings SET recurrence_series_id = new` WHERE forward set.
3. `UPDATE source recurrence_series SET series_end_at = pivot.start_at`.
4. `try { INSERT audit_events booking.recurrence_split } catch {}` —
   swallowed.

Failure modes:

- **Crash between writes 1 and 2** → an orphan recurrence_series row no
  occurrence references (permanent garbage on a shared DB).
- **Non-idempotency on retry.** The surrounding `editScope`
  `this_and_following` commit calls `splitSeries`. A network failure
  after the split committed but before the response reached the client
  triggers a retry; the retry would call `splitSeries` again and mint a
  SECOND orphan series. The pre-Slice-4 code papered over this with a
  brittle TS `skipSplitSeries` command_operations pre-check
  (reservation.service.ts:1696-1743 + the retry special-case at
  :1779-1792) — a hack that read `command_operations` purely to suppress
  the second split. That hack had its OWN history of CRITICAL bugs (the
  codex 2026-05-12 C1/C2 round: dry-run replaying a commit cache;
  payload_mismatch bypass).
- **Swallowed audit.** The `catch {}` meant a failed audit insert was
  invisible — the split's only durable record could silently vanish.

## 2. The design — RPC-only, mirroring the canonical pattern

`splitSeries` is now a THIN one-call wrapper over a new atomic,
idempotent PL/pgSQL RPC `split_recurrence_series` (migration
`00411_split_recurrence_series.sql`), byte-mirroring the canonical
`cancel_booking_with_cascade` (00408) / `edit_booking` (00407) pattern:

- **command_operations idempotency gate** — plain deterministic
  `md5(coalesce(p_booking_id)||'|'||coalesce(p_tenant_id)||'|'||coalesce(p_actor_user_id))`.
  No server-stamped field in the tuple → no
  `booking_edit_idempotency_payload_hash` strip helper (it targets
  EditPlan jsonb, not this tuple). cache-hit (success + hash match) →
  return cached_result; payload-mismatch → raise P0001; else
  unexpected_state; then `insert ... 'in_progress'`. Mirrors 00408
  exactly.
- **F-CRIT-1 actor block** — `auth_uid → users.id` once
  (`where u.auth_uid = p_actor_user_id and u.tenant_id = p_tenant_id`);
  raise `split_recurrence_series.actor_not_found` if null AFTER lookup.
  `p_actor_user_id` MAY be null for system/synthetic callers (the
  recurrence cron has no JWT subject) — handled exactly like 00408: skip
  the lookup when null; the audit row's actor_user_id is then null.
- **Advisory lock on (tenant, idempotency_key)** — see §3.
- **Pivot FOR UPDATE + tenant validation**; `not_found` /
  `not_recurring` raises.
- **Source recurrence_series FOR UPDATE**; forward booking set locked
  `ORDER BY id FOR UPDATE` (deadlock-safe, same rationale as
  00408:317-324).
- **The 3 writes in ONE tx** (the function body IS the tx). Every UPDATE
  explicitly carries `tenant_id = p_tenant_id` (defense-in-depth even
  though the predicate is tenant-derived — the tenant-on-write rule from
  00408:419-421). The new-series INSERT copies the EXACT column set the
  legacy splitSeries copied (recurrence.service.ts:808-819;
  recurrence_series schema 00124:5-17 + parent_reservation_id →
  parent_booking_id rename 00278:179-184).
- **In-tx audit_events** (`booking.recurrence_split`, entity_type
  `recurrence_series`, entity_id = source series id) — NOT best-effort,
  NOT swallowed. If the audit insert fails the whole split rolls back.
  This directly replaces the swallowed `try/catch` (the third failure
  mode in §1).
- **revoke all from public; grant execute to service_role;
  `security definer`; `set search_path = public, outbox`.**

The result is the brief's mandate: the 3 writes + the audit are atomic;
a retry of the same editScope returns the SAME `new_series_id`, no
orphan series. The TS `skipSplitSeries` hack is **DELETED** — its entire
job (suppress the non-idempotent second split) is now owned by the RPC's
command_operations gate, end-to-end. This is the same posture as the
Slice-2 `cancel_booking_with_cascade` cutover.

## 3. Advisory-lock-on-idempotency-key rationale (NOT per-booking)

00408 (cancel) locks on `(tenant, booking, cancel)` because cancel
serializes on the booking — a concurrent retry of a *different* crid for
the same booking still must serialize. 00411 (split) instead locks on
`(tenant, idempotency_key)`, mirroring **00407** (edit_booking), because:

- The split runs INSIDE `editScope` and is keyed on the SAME
  (bookingId, clientRequestId) the surrounding editScope uses
  (`buildSplitSeriesIdempotencyKey(bookingId, clientRequestId)`).
- The retry boundary for a split is the editScope REQUEST, not the
  booking. Two genuinely-different editScope requests against the same
  pivot would have different crids → different split keys → they must
  NOT serialize on a shared per-booking lock (that would needlessly
  block a legitimate independent edit). A concurrent RETRY with the
  SAME key serializes here, and the command_operations gate then
  short-circuits the loser to the cached result.

This is the brief's explicit instruction (mirror 00407's
lock-on-idempotency-key shape, NOT 00408's per-booking shape).

## 4. THE NO-OUTBOX-EMIT DECISION (explicit deferral — NOT silent)

The legacy splitSeries emitted **NO outbox event** — its only
side-channel was the swallowed `audit_events` insert. A repo-wide grep
for consumers of `recurrence.series_split` / `series_split` in
`apps/api/src` + `supabase/migrations` (excluding tests) returned
**ZERO** non-test hits. There is no outbox handler, no workflow
producer, no notification adapter, no calendar-sync consumer that reads
a recurrence-split event.

**Decision: the RPC emits NO outbox event.** Emitting an outbox event
with zero registered consumers is speculative — it would sit forever in
`outbox.events` un-drained, adding noise + a misleading "this event has
meaning" signal that future engineers would have to reverse-engineer.
The in-tx `audit_events` row (no longer best-effort, no longer
swallowed) is the durable record of the split, sufficient for audit-
trail integrity (the P1-2 requirement).

**This is an EXPLICIT, OWNED deferral, not a silent omission:**

| Field | Value |
|---|---|
| Deferred | `outbox.emit('recurrence.series_split', ...)` (or similar) |
| Why | Zero consumers found (grep-verified). Unconsumed outbox events are speculative noise. |
| Owner | booking-audit workstream |
| Revisit trigger | The moment a downstream consumer materialises that needs to react to a series split — e.g. calendar resync needing to re-key occurrences after a series-id change, or a reporting pipeline reconciling series lineage. **Specifically: Outlook / MS-Graph bi-directional sync re-keying occurrences after a series-id change** — this is a Tier-1 must-have (`project_outlook_integration`; today's Outlook bookings already cause double-bookings + bad UX, and a series-split that silently re-keys occurrences without an event for the calendar-sync consumer would desync the mirrored Outlook series). When the MS-Graph sync consumer lands, this deferral MUST be revisited. At that point add the emit (00373 signature) INSIDE the RPC tx (best-effort post-commit emissions go through `OutboxService.emit()` per CLAUDE.md, but a domain-critical split-lineage event should be in-tx like 00408's emits). |
| Risk | **Low.** The audit_events row already captures pivot_booking_id / pivot_start_at / new_series_id / forward_count. Adding the emit later is additive (new event type, new handler) — no migration to the split RPC's contract, no replay concern (the command_operations gate already makes the whole RPC idempotent, so an added in-tx emit inherits idempotency for free). |

## 5. Removal of the TS suppression hack — now correct in the RPC

The `skipSplitSeries` pre-check (reservation.service.ts:1696-1743) + the
retry special-case (:1779-1792) are **DELETED**. They were a TS-layer
mitigation for a DB-layer non-idempotency. With the RPC owning
idempotency:

- First attempt: `splitSeries` → RPC mints the new series under
  `booking:recurrence:split:<bid>:<crid>`, moves the pivot + forward
  bookings, returns `new_series_id`. `effectiveSeriesId = new_series_id`.
  The edit_booking_scope RPC commits + caches under
  `booking:edit:scope:<bid>:<crid>`.
- Retry (same crid): `splitSeries` → SAME split key → RPC cache-hits →
  returns the SAME `new_series_id` (no second series; the pivot is
  already on it). `effectiveSeriesId` = the SAME value. The assembler
  walks the post-split series (pivot already there) and re-derives the
  same plans; the edit_booking_scope RPC returns its own cached_result
  (00371:266-267) or raises payload_mismatch if the body differed.

**No orphan series, no double-apply, no TS pre-check.** The
retry-replay correctness is traced inline in
`reservation.service.ts` editScope (the SPLIT IDEMPOTENCY JSDoc block +
the in-body comment) and proven by the live smoke (§6).

The structural invariant that makes removing `skipSplitSeries` safe on
the retry path is the assembler's defense-in-depth guard at
`assemble-edit-plan.service.ts:459`
(`if (pivot.recurrence_series_id !== args.effectiveSeriesId) throw
edit_booking_scope.series_mismatch`). On retry the split RPC cache-hits
and returns the SAME `new_series_id`; `effectiveSeriesId` is set to that
value (reservation.service.ts:1757) and the pivot row is already on it
(moved by the first attempt), so `pivot.recurrence_series_id ===
effectiveSeriesId` holds and the assembler re-derives the same in-scope
set with no special-casing. If a retry ever saw a pivot whose series did
NOT match (an internal inconsistency the old `skipSplitSeries` hack
silently papered over), :459 hard-fails with a clear code instead of
producing a wrong plan. This is the invariant — not just prose — that
makes the skipSplitSeries removal retry-replay safe.

## 6. Smoke contract (smoke-edit-booking-scope.mjs)

Scenario 7b (NEW) asserts the REAL atomic + idempotent behavior on top
of the existing Scenario 7 `this_and_following` commit:

- (i) exactly **1** `recurrence_series` row points at the pivot
  (`parent_booking_id = pivot`) — no orphan from the legacy 3-write
  race.
- (ii) the split's **own** `command_operations` row exists with
  `outcome=success` (the RPC's idempotency gate fired).
- (iii) **RETRY** the same editScope (same crid, same body) → returns
  the **SAME** `new_series_id`; the total fixture `recurrence_series`
  footprint is **unchanged** across the retry (NO second/orphan series
  minted — the core P1-2 regression); still exactly 1 series anchored
  at the pivot.
- (iv) the split `command_operations` row count stays **1** after the
  retry (cache-hit, not a re-execute).

Existing scope probes (dry-run, series commit, idempotency replay,
payload_mismatch, wrong-endpoint, time-shift-reject, invalid-scope,
missing-header, B.4.A.5 approval-flip) stay green unchanged. Cleanup
extended to sweep the split RPC's `booking:recurrence:split:%`
`command_operations` rows + the `entity_type='recurrence_series'`
`booking.recurrence_split` audit row (the pre-existing sweeps only
matched `booking:edit:scope:%` + `entity_type='booking'`).

## 7. Error codes registered (4-file change, mirrors cancel_* pattern)

Three new dotted codes, registered EXACTLY how Slice 2 registered the
`cancel_booking_with_cascade.*` family:

| Code | Status | File rows |
|---|---|---|
| `split_recurrence_series.actor_not_found` | 404 | map-rpc-error.ts STATUS_BY_CODE + error-codes.ts KnownErrorCode union + runtime registry + messages.en.ts + messages.nl.ts |
| `split_recurrence_series.not_found` | 404 | (same 5 rows) |
| `split_recurrence_series.not_recurring` | 422 | (same 5 rows) |

`command_operations.payload_mismatch` (409) / `.unexpected_state` (500)
are shared cross-RPC codes, already registered. The 3 generic arg-shape
raises (`split_recurrence_series: p_*_id required`) intentionally have
NO dotted code — they route to the `booking.recurrence_failed` 500
fallback (server-class; a non-HTTP caller passed a malformed tuple).
`mapRpcErrorToAppError` routes recognised raises to their canonical
codes; the wrapper's fallback is `booking.recurrence_failed` (the
pre-existing booking-scoped 500, already registered).

## 7b. Newly-surfaced PRE-EXISTING failures (NOT Slice 4 regressions — explicit)

Running the smoke to completion (it previously **aborted early** on the
pre-existing `command_operations.id` harness bug — see §7c) exposed
three pre-existing defects that were latent because the harness never
reached them. None is caused by Slice 4. Each is documented here so the
gate's residual fails are honest, not silently passed:

1. **`Series commit replay` — pre-existing `edit_booking_scope`
   payload-hash non-determinism (root cause is the PRODUCER, NOT the
   hash helper).** A same-body editScope replay (`scope='series'`, same
   crid) returns 409 `command_operations.payload_mismatch` instead of
   the cached envelope.

   **Root cause — VERIFIED against the LIVE remote DB
   (2026-05-17):** `edit_booking_scope` ALREADY hashes its `p_plans`
   via `public.booking_edit_idempotency_payload_hash` — confirmed by
   `pg_get_functiondef('public.edit_booking_scope(jsonb,uuid,uuid,text,boolean)'::regprocedure)`
   line 176: `v_payload_hash :=
   public.booking_edit_idempotency_payload_hash(p_plans);`. Slice 1's
   00407 (`00407_booking_edit_idempotency_intent_hash.sql:1256`)
   re-pointed **both** `edit_booking` (00407:310) AND
   `edit_booking_scope` (00407:1256) at the strip helper; 00407 is on
   remote (`booking_edit_idempotency_payload_hash` +
   `booking_edit_strip_hash_server_fields` both exist on the remote
   `pg_proc`). The strip helper recurses through objects AND arrays,
   stripping `_resolution_at` at every depth — empirically verified on
   remote: two `p_plans` arrays differing ONLY in `_resolution_at` (top
   level + nested) hash IDENTICALLY. So the 409 is **NOT** a raw-md5 vs
   strip-helper bug, and it is **NOT** `_resolution_at`.

   The remaining cause is exactly what the 00407 header itself states
   (00407:24-26, :49-53): the strip helper deliberately covers ONLY the
   `_`-prefixed server fields; the **producer**
   (`assemble-edit-plan.service.ts`) is responsible for canonicalising
   the non-`_`-prefixed retry-unstable arrays. Slice 1's producer-side
   canonicalisation (assemble-edit-plan.service.ts :777/:780/:795/:806
   /:1072/:1160/:1213 — order-stabilising `.sort()`s) is present but
   does NOT fully stabilise the SCOPE path: at least one non-`_`-prefixed
   per-plan value (not order — value) still varies across re-assembly of
   a multi-booking `p_plans` array, so the post-strip md5 still differs
   on replay. Identifying and canonicalising that specific producer
   field is a bounded but genuine **future booking-audit slice** — it is
   `assemble-edit-plan.service.ts` producer territory, **explicit Slice
   4 do-not-touch**, NOT a one-line SQL hash swap.

   **A "fold D-5 / author 00412 to re-point edit_booking_scope at the
   strip helper" remediation was investigated and FALSIFIED.** It would
   be a NO-OP: the live function (line 176) already calls the helper;
   00407 already did exactly that swap in Slice 1 for the scope path.
   Authoring such a migration would be a dishonest "fix" that changes
   nothing while claiming to close D-5. The honest ledger entry is: D-5
   is a real pre-existing producer-determinism bug, owned by a future
   booking-audit slice, NOT closeable by a Slice-4 one-liner.

   The same non-determinism is what makes the Slice 4 "RETRY same
   editScope" probe expect a 409 (see §6 (iii) / §9c) — the SPLIT is
   still idempotent (proven directly at the DB level by §6 (ii)); the
   editScope envelope 409 is this pre-existing producer bug.
   **Owner:** booking-audit workstream (assemble-edit-plan SCOPE-path
   producer determinism — a future slice). **Risk:** Medium for real
   users (a legitimate same-body scope-edit retry surfaces a confusing
   409 instead of the idempotent replay) — but pre-existing and out of
   scope; flagged, not silently deferred, and explicitly NOT
   misrepresented as a closeable one-liner.

2. **`deleteFixture` split-child slot-orphan cleanup gap (FIXED in this
   slice — in scope).** The pre-fix cleanup deleted `booking_slots`
   keyed ONLY on the ORIGINAL `seriesId`. After a `this_and_following`
   commit the split moves forward bookings to a NEW series; their slots
   were therefore NOT deleted, then the title-scoped booking delete
   removed the parent bookings — **orphaning the slots permanently**.
   Those orphan slots on ROOM_BOARD at the fixture window were a GiST
   landmine that made every SUBSEQUENT run's TAF commit 409
   `booking.slot_conflict`. This is in Slice 4 scope (the smoke gates
   the split path). **Fix:** delete slots for the FULL fixture booking
   set (original-series OR `title='Smoke edit-scope series'`, which
   catches the split-children) BEFORE deleting the bookings; the
   audit/domain/outbox/approval sweeps were widened to the same
   full-set predicate. Pre-existing accumulated orphan slots on the
   shared remote were also purged as a one-time cleanup.

3. **Flip Assertion 3 `PGRST106 Invalid schema: outbox` (FIXED in this
   slice — in scope, robustness).** The pre-existing B.4.A.5 flip
   probe's `readFlipOutboxForBookings` used supabase-js
   `.schema('outbox')`, which 400s on this remote (PostgREST exposes
   only `public, graphql_public`) and **threw uncaught, aborting the
   ENTIRE gate** and masking the Slice 4 probe results. Switched to a
   `psql`-backed read (the `outbox` schema IS reachable on direct
   postgres; the smoke already shells psql for fixtures).
   Behavior-preserving; the probe now passes.

## 7c. The `command_operations.id` harness bug (FIXED — in scope)

`countCommandOpsForPivot` (pre-existing, committed on this branch)
selected `.select('id', ...)` from `command_operations`, which has NO
`id` column (00316 schema: tenant_id, idempotency_key, payload_hash,
outcome, cached_result, enqueued_at, completed_at). PostgREST 400s with
an empty-message error, which the helper re-threw and **aborted the
entire smoke right after the first dry-run** — i.e. the
`smoke:edit-booking-scope` gate has been **non-functional on this
branch** (confirmed by running the committed HEAD smoke: it dies at the
same point). Fixed: count over `idempotency_key` (a real column); the
new Slice 4 helpers use the same correct shape. This is squarely in
Slice 4 scope (the smoke gates the split path; an aborting harness
cannot gate anything).

## 8. Accepted residuals (EXPLICIT — none silent)

| # | Residual | Owner | Risk |
|---|---|---|---|
| **R-a** | The `recurrence_index` field is no longer read by splitSeries (the legacy body selected it but only used `start_at` for the forward predicate). The RPC uses `start_at >= pivot.start_at` for the forward set, exactly as the legacy `.gte('start_at', p.start_at)` did — semantically identical. No `recurrence_index` regression; noted only because the legacy projection selected it. | n/a (documented parity) | **None** — behavior-preserving. |
| **R-b** | No dedicated payload-mismatch probe ON THE SPLIT KEY in the live smoke. The split crid is derived from (pivot.bookingId, editScope crid); the smoke harness drives the split only transitively via editScope, so it cannot mint a same-split-key/different-pivot request without a bespoke direct-RPC harness. Mitigation: the split RPC's command_operations gate is a byte-mirror of 00408's (codex-reviewed in Slice 2); the editScope payload-mismatch probe (Scenario 5) exercises the SAME gate shape; the split's own gate is unit-covered by the RPC body's structural mirror of 00408. | booking-audit workstream | **Low** — the gate code is identical to a codex-reviewed RPC; the missing probe is the split-key-direct path only. |
| **R-c** | The `recurrence.service.ts` `txBoundary.runWithCompensation` clone caller (the recurrence-clone path, ~:531 region — audit 03 P2-1) is UNTOUCHED by Slice 4 and remains the legacy in-process-compensation pattern. This is the explicit scope guard for this slice (P2-1 is a later slice). Splitting it out keeps the diff bounded. | booking-audit workstream (P2-1 slice) | **Bounded** — pre-existing, untouched, separately tracked. |
| **R-d** | NO outbox emit (the §4 deferral). Re-stated here for the single-glance residual view. | booking-audit workstream | **Low** (see §4). |
| **R-e** | `Series commit replay` pre-existing `edit_booking_scope` payload-hash non-determinism (§7b #1). 1 residual fail in `smoke:edit-booking-scope` (45 pass / 1 fail). NOT a Slice 4 regression — surfaced because §7c's harness abort is fixed. **Verified (2026-05-17): the hash-helper "fold" is a NO-OP — live `edit_booking_scope` already uses `booking_edit_idempotency_payload_hash` (00407:1256). Root cause is the `assemble-edit-plan.service.ts` SCOPE-path producer emitting a non-`_`-prefixed value that varies across re-assembly, NOT a raw-md5/strip-helper gap. Not closeable by a Slice-4 one-liner.** | booking-audit workstream (assemble-edit-plan SCOPE-path producer determinism — future slice) | **Medium** for users (confusing 409 on a legitimate same-body scope-edit retry); **out of Slice 4 scope** (do-not-touch). |

## 9. Validation evidence

- `00411` applied to local postgres directly + pushed to remote via the
  psql fallback; `pg_get_functiondef` on remote VERIFIED: command_operations
  gate, `pg_advisory_xact_lock`, F-CRIT-1 (`auth_uid = p_actor_user_id`
  + `split_recurrence_series.actor_not_found`), the 3 writes
  (INSERT recurrence_series + UPDATE bookings + UPDATE recurrence_series),
  in-tx `insert into public.audit_events` (`booking.recurrence_split`),
  NO `outbox.emit` (the §4 decision confirmed at the DB level),
  `SECURITY DEFINER`, `SET search_path TO 'public', 'outbox'`,
  revoke/grant trailer byte-identical to canonical 00408.
- `pnpm smoke:edit-booking-scope`: **45 pass / 1 fail**. ALL 7 new
  Slice 4 Scenario 7b probes PASS (1 series for pivot / 1 split
  command_operations success / retry → editScope 409 [pre-existing] /
  recurrence_series count unchanged across retry — NO orphan / still 1
  series at pivot / split command_operations still 1×success). The 1
  fail is the §7b #1 pre-existing `edit_booking_scope` non-determinism
  (R-e — out of scope, documented). Remote orphan-recurrence_series
  count = **0** (the P1-2 fix holds).
- `pnpm smoke:edit-booking`: 75 pass / 1 fail (the documented
  pre-existing edit NOOR-flip 1-fail — tolerated per the slice brief).
- `pnpm smoke:cancel-booking`: first run flaked on the documented
  non-deterministic OBX-drain; re-run = **138 pass / 0 fail**.
- `pnpm smoke:create-multi-room`: **46 pass / 0 fail** (clean — no
  Slice 4 regression to the multi-room atomic-create path).
- `jest src/modules/reservations` green (the
  `reservation-edit-scope.spec.ts` ex-pre-check tests rewritten to the
  new RPC-idempotent contract; the 2 tests of the deleted TS pre-check
  internals removed with a documented removal note — not gutted).
- `pnpm errors:check-app-errors` clean; `tsc --noEmit` clean.

## 9b. Rollback posture (forward-only)

`00411_split_recurrence_series.sql` is a forward-only
`create or replace function` on the **shared remote** project. There is
**no clean DB-only rollback**: the pre-Slice-4 `splitSeries` was a TS
method (3 non-atomic supabase-js writes), not a prior SQL function, so
there is no earlier function body to `create or replace` back to.
Reverting means: `git revert` the TS change (restoring the non-atomic
`splitSeries` choreography + the `skipSplitSeries` hack) **and**
`drop function if exists public.split_recurrence_series(...)` on remote
— which re-exposes the original P1-2 bug (orphan recurrence_series on
crash/retry). Treat 00411 as a one-way door; a regression is fixed
forward (a new migration), not rolled back. There is no 00412 in this
slice (see §7b #1 — the investigated D-5 "fold" was a no-op against the
already-Slice-1-fixed live `edit_booking_scope`; nothing was authored).

## 9c. Honesty caveat on the §6 Scenario 7b probes

The §6 (iii) "no orphan series on retry" assertion is **partially
neutered against the LEGACY bug** and must NOT be over-sold as the
load-bearing P1-2 regression catcher. The pre-fix `skipSplitSeries` TS
hack ALSO produced no second series on the editScope retry (that was
literally its purpose — it skipped the second split call). So (iii)
alone does not distinguish "fixed correctly by the atomic RPC" from
"papered over by the old hack". The **load-bearing** regression catcher
is §6 (ii): **exactly 1 split `command_operations` row with
`outcome=success`**. That row only exists because the
`split_recurrence_series` RPC ran and its idempotency gate fired — the
legacy TS path wrote no `command_operations` row at all. (ii) is what
proves the atomic-idempotent RPC is genuinely in the path; (iii)/(iv)
are corroborating, not primary.
