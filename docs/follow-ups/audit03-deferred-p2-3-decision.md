# audit-03 P2-3 — consolidate the two `create_booking` RPC families — DECISION + CLOSURE

**Status:** CLOSED (flat case) + DEFERRED-WITH-OWNER (workflow-def case).
audit-03 deferred-closeout slice. Authoritative record of (a) the
consolidation, (b) the C1 NOT-NULL trap caught pre-coding, (c) the C2
systemic-fix disposition (fixed in-slice), (d) the flat-atomic /
workflow-def-hybrid scope, (e) the recurrence-determinism decision, (f) the
verified-benign `booking.created`-for-no-services emission, (g) the revoke.

Append-only: the existing rows in
`docs/follow-ups/audits/03-booking-reservation.md` Closure Ledger are left
verbatim; this slice appends NEW rows and this doc supersedes nothing by
rewrite.

---

## 1. The consolidation

Before P2-3 there were TWO create-a-booking RPC families:

- **WITH services** → `create_booking_with_attach_plan` (00372 live body):
  one atomic Postgres transaction (booking + slots + orders + OLIs +
  asset_reservations + approvals + outbox emissions); idempotent on
  `(tenant_id, idempotency_key)` via `attach_operations`.
- **NO services** → legacy 20/21-arg `create_booking` RPC (00277:236-334):
  booking + slots only; approval rows created AFTER the RPC by a
  best-effort TS `createApprovalRows` (`supabase.admin.from('approvals')
  .insert(...)`), NOT atomic with the booking.

Two RPCs, two approval-row code paths, two idempotency stories, one gate
(`booking-flow.service.ts:142 if (input.services?.length>0)`). The only
live caller of the legacy RPC was `BookingFlowService.create`'s no-services
branch (multi-room already on the combined RPC since Slice-3/P1-1;
recurrence + Outlook-sync create through the SAME `bookingFlow.create`
gate).

**P2-3 collapses this to ONE family.** `create()` now unconditionally
delegates to `createWithAttachPlan` → `create_booking_with_attach_plan`.
`buildAttachPlan` produces an empty service graph for the no-services case,
plus (FLAT approval case) the deterministic chain-aware approval rows the
combined RPC commits IN-TRANSACTION. The legacy `create_booking` RPC + its
TS call site + `createApprovalRows` are deleted; the RPC is revoked
(migration 00430, revoke-not-drop).

Migrations claimed (next-free-slot at write time): **00429** (extend the
combined RPC's step-10 approvals INSERT 7→11 cols) + **00430** (revoke the
legacy RPC).

---

## 2. CRITICAL C1 — the NOT-NULL trap (caught BEFORE coding)

`public.approvals.chain_threshold` is `text NOT NULL DEFAULT 'all'`
(00400:45). The combined RPC's *pre-P2-3* step-10 INSERT wrote only 7
columns and **omitted `chain_threshold` entirely** — so it landed `'all'`
purely via the column default.

The moment a value expression is added for `chain_threshold`, an absent
JSON key MUST still resolve to `'all'`, NOT NULL. Every EXISTING
with-services pending-approval booking is created via this RPC with
`assemblePlan` rows that have NEVER carried a `chain_threshold` key. An
explicit `NULL` into the NOT NULL column aborts with **23502** and would
break EVERY existing with-services approval booking — a strict P0
regression on a path that works today.

**Fix (verified in the 00429 body diff):**
`chain_threshold := coalesce(nullif(v_approval->>'chain_threshold',''),'all')`
— absent OR empty-string → `'all'`, byte-behaviour-identical to today's
column-default behaviour. The 3 genuinely-nullable added columns
(`approval_chain_id`, `parallel_group`, `approver_team_id`) use
`nullif(...,'')::T` so an absent key → SQL NULL (their pre-00429 behaviour:
the INSERT never wrote them, so they defaulted to NULL). The
`approver_person_id` expression is left **verbatim-00372**
(`(v_approval->>'approver_person_id')::uuid`): for a team-only row the plan
emits JSON `null` → `->>` yields SQL NULL → `(NULL)::uuid` = NULL
(behaviour unchanged for the pre-existing person-only rows).

**Migration A is provably verbatim-00372 + ONLY the 4-col delta.** A
comment-stripped body diff (`00372` vs `00429`) shows exactly three hunks:
(i) +4 column names in the step-10 INSERT, (ii) +4 value expressions in the
step-10 INSERT, (iii) the non-executable `comment on function` docstring.
Nothing else — the advisory lock, the `attach_operations` gate (md5 hash,
in_progress insert, ON CONFLICT branches), `any_deny` short-circuit, both
validators, the booking INSERT, all the slot/order/AR/OLI loops, the
guarded `setup_work_order.create_required` emit, the `booking.created`
outbox emit + its idempotency key, the cached-result assembly + success
UPDATE, `security invoker` / `set search_path`, the
`revoke … from public; grant … to service_role;` footer, and the final
`notify pgrst` are byte-identical.

---

## 3. C2 — systemic pre-existing P0 — FIXED IN-SLICE

**The finding (systemic, pre-existing, NOT P2-3-caused).** The
with-services plan builder `ApprovalRoutingService.assemblePlan` emitted
person-only approval rows with NONE of the 4 chain columns. The combined
RPC's 7-col INSERT therefore persisted `approval_chain_id = NULL` for
EVERY with-services pending-approval booking. The 00402 inbox-notification
trigger `return new`-SKIPS when `approval_chain_id IS NULL`. ⇒ **every
with-services pending-approval booking created via the combined RPC has
been silently un-notified** (corroborated by the in-code admission at the
old `booking-flow.service.ts:~592-598`). Systemic, pre-existing, present
on `main` today.

**Disposition: FIXED IN-SLICE (the default; D-12 NOT needed).**
`assemblePlan` already has `idempotencyKey` + `target_entity_id` (the
deterministic planUuid-derived `bookingId`) in scope, so a deterministic
shared chain id is derivable without new infra:

- `approval_chain_id = planUuid(idempotencyKey, 'approval', '__chain__')` —
  ONE shared id per call, byte-stable across same-intent retries (NOT
  `randomUUID()` — that is the exact D-5/D-6 class bug: a fresh random in
  the idempotency-hashed `p_attach_plan` trips `attach_operations.
  payload_mismatch` 409 on retry). The `'__chain__'` stableIndex reuses the
  existing `PlanRowKind` enum (`'approval'`) and cannot collide with a real
  approver key (those are UUIDs, never the literal `'__chain__'`).
- `chain_threshold = 'all'` — the `createApprovalRows` default and the
  correct semantic here: the service-rule path aggregates approvers from
  per-line outcomes with NO single per-chain threshold concept; each row is
  an independently-required approver (≡ all-of).
- `parallel_group = 'parallel-' + target_entity_id` (threshold='all' ⇒
  parallel group, mirroring `createApprovalRows`; bookingId is
  planUuid-derived ⇒ deterministic).
- `approver_team_id = null` — this path ONLY ever resolves person approvers
  (person / role→persons / derived→persons; see `resolveApproverTarget`).
  Never team.

Net: the canonical with-services pending-approval path is now
inbox-notified. `AttachPlanApproval` gained 4 optional fields
(`approval_chain_id?`, `parallel_group?`, `chain_threshold?`,
`approver_team_id?`) + `approver_person_id` widened to `string | null`
(team-only rows from the no-services FLAT path).

---

## 4. Flat-atomic / workflow-def-hybrid scope (TIGHTENED wording)

The no-services approval builder (STEP C, `buildAttachPlan` else-branch)
has two sub-cases, mirroring the legacy `create` fan-out at the old
`booking-flow.service.ts:~367-377`:

- **FLAT case** (`status==='pending_approval' && approvalConfig &&
  !approvalWorkflowDefinitionId`): the plan emits the approval rows
  mirroring `createApprovalRows` OUTCOME with HARD determinism — each row
  `id = planUuid(idempotencyKey,'approval',<approver.id>)`; ONE shared
  `approval_chain_id = planUuid(idempotencyKey,'approval','__chain__')`;
  `parallel_group = chain_threshold==='all' ? 'parallel-'+bookingId :
  null`; `chain_threshold = approvalConfig.threshold ?? 'all'`; person/team
  split EXACTLY like `createApprovalRows`
  (`approver_person_id=type==='person'?id:null`,
  `approver_team_id=type==='team'?id:null`); `status='pending'`.
  `canonicalApproverSort(required_approvers)` is applied BEFORE mapping
  (raw rule JSON has no inherent order — unsorted = D-5/D-6-class 409); its
  `(type,id)` order IS the determinism guarantee (the plan-sort
  `comparePlanApprovals` keys on `approver_person_id` which is NULL for
  team rows — unusable here, deliberately not used). `any_pending_approval`
  is set `true` AND `bundle_audit_payload.any_pending_approval` in
  lockstep. **This case is now ATOMIC**: the approval rows commit
  IN-TRANSACTION with the booking via the 00429 RPC and the 00402 trigger
  fans out inbox notifications. This is a genuine IMPROVEMENT over the
  legacy path (legacy: best-effort post-RPC TS insert that could fail
  silently leaving a stuck booking).

- **WORKFLOW-DEF case** (`approvalWorkflowDefinitionId` set): the plan
  emits `approvals:[]`, `any_pending_approval:false`. The booking commits
  atomically; `createWithAttachPlan` then starts the `workflow_instance`
  POST-RPC, best-effort (try/catch + log), exactly as the legacy `create`
  fan-out did. **Precise wording: atomic for the flat case; equivalent —
  not improved, not regressed — for the workflow-def case whose approval
  rows are engine-owned, deferred-with-owner.** The engine's approval node
  owns the approval rows + their chain id + their notification; making that
  atomic with the booking is a workflow-engine concern outside P2-3 scope.
  Owner: the universal-workflow workstream (Phase 1.B+).

**No double-notify.** For FLAT rows the ONLY notification path is the 00402
trigger (no TS-side `onApprovalRequested` call remains on this path; its
ON CONFLICT (tenant_id,user_id,event_kind,chain_id) DO NOTHING makes even a
retried insert idempotent). For WORKFLOW-DEF rows the engine's approval
node owns it. `onCreated` (the requester-facing "your booking is in"
message) still fires for both; the approver-facing message is never
double-sent.

---

## 5. Recurrence determinism — DECISION: keep the random key (no thread)

`RecurrenceService.SYSTEM_ACTOR` has no `client_request_id` (and no
`resolution_basis_at`). `createWithAttachPlan` derives
`idempotencyKey = booking.create:${actor.user_id}:${actor.client_request_id
?? randomUUID()}` — so each recurrence occurrence's create gets a FRESH
RANDOM idempotency key per call.

**Decision: KEEP the random key. Do NOT thread a deterministic
`recurrence:${seriesId}:${occ.index}` key.** Justification:

1. **The `attach_operations` gate is effectively single-shot for
   recurrence, and that is SAFE.** The materialiser has NO client-retry
   semantics: each occurrence is created exactly once per `materialize()`
   tick. If a tick fails mid-materialise, the next tick re-queries
   `existingIndices` (recurrence.service.ts:~445/481:
   `if (existingIndices.has(occ.index)) continue;`) and SKIPS already-
   materialised `recurrence_index` values before ever calling `create`.
   Duplicate-occurrence is contained at the `existingIndices` guard, NOT at
   `attach_operations` — so a fresh random key per call is correct (no
   retry is expected; the dedup happens one layer up).
2. **Threading a deterministic key would ADD risk, not remove it.** A
   deterministic `recurrence:${seriesId}:${occ.index}` key means a
   failed-then-retried occurrence whose plan changed between ticks (e.g. an
   admin edits a rule between rollover ticks) would hit
   `attach_operations.payload_mismatch` 409 instead of the benign
   `existingIndices` skip — converting a self-healing path into a hard
   error. The random-key + existingIndices design is intentional and is
   the lower-risk choice.

C1-recurrence correctness (the 00429 INSERT must keep chain cols for
`recurrence_index` rows) is asserted directly at the RPC boundary by smoke
probe (k) — see §7.

---

## 6. Verified-benign `booking.created`-for-no-services emission

The combined RPC's step-12.5 unconditionally emits a `booking.created`
outbox event (00372). Pre-P2-3 the no-services path used the legacy
`create_booking` RPC which did NOT emit it (only a TS-side `audit_events`
row). Post-P2-3 EVERY no-services create also emits `booking.created`.

**Verified benign.** The sole consumer is
`WorkflowSpawnWakeOnBookingCreatedHandler` (registered on
`'booking.created'`). It is resume-only: it queries
`workflow_instance_links` by `tenant_id + child_entity_id +
spawn_mode='wait' + resolved_at IS NULL` and resumes any WAITING parent
workflow. A brand-new no-services booking has NO pre-existing
`workflow_instance_links` row pointing at it ⇒ the handler finds nothing ⇒
no-op. No user-visible behaviour change. (Per the 00372 header §
producer-before-consumer, a missing handler dead-letters benignly with
`no_handler_registered` — also no user-visible regression.) **One-line
note for the future:** if a future consumer of `booking.created` is added
that acts on no-services bookings, this benign-ness MUST be re-analysed —
the no-services path now emits the event where it previously did not.

---

## 7. The new fail-closed smoke gate (probes h-k)

`smoke:recurrence-clone` seeds WITH services + forces `confirmed`, so the
no-services pending-approval path was NEVER live-covered.
`smoke:create-multi-room` is extended with self-contained probes (h)-(k)
(3 dedicated rooms + 2 dedicated room-scoped `require_approval` rules + a
dedicated team + membership; the admin user is the deterministic approver
so the 00402 `users` / `team_members` join finds a row):

- **(h)** no-services, no approval rule → 2xx `confirmed`, **0** approval
  rows, exactly 1 `attach_operations` row, ≥1 slot.
- **(i)** no-services + FLAT person-approver rule → `pending_approval`, ≥1
  approval row with `approval_chain_id IS NOT NULL` + `chain_threshold='all'`
  + `approver_person_id` set + `status='pending'`, **≥1
  `inbox_notifications` row** (THE exact P0 signal), exactly 1
  `attach_operations` row, `grant_booking_approval` resolves the chain.
- **(j)** FLAT team-approver rule → `approver_team_id` set +
  `approver_person_id NULL` + `approval_chain_id NOT NULL`, ≥1 inbox row
  via the 00402 team branch.
- **(k)** C1-recurrence: a recurrence-tagged (`recurrence_series_id` +
  `recurrence_index=7`) combined-RPC create with a chain-bearing approval,
  invoked at the RPC boundary directly → occurrence persists its
  recurrence tags AND the approval keeps `approval_chain_id` /
  `chain_threshold` / `parallel_group` (the 00429 INSERT must NOT
  special-case `recurrence_index`) + ≥1 inbox row. RPC-boundary assertion
  chosen because the materialiser's master-confirmed/occurrence-approval-
  gated arrangement is fragile to seed drift; the boundary assertion is the
  precise C1-recurrence signal.

Real fail-closed: `passAssertion` feeds `results.fail` → `main()` exits 1.
Fixture cleanup additionally sweeps `inbox_notifications` (keyed
`payload->>'booking_id'`), the dedicated `teams`/`team_members`, and the
dedicated `room_booking_rules`. The orchestrator runs the live smokes in
the batch pass; the script is `node --check`-verified here.

---

## 8. The revoke (migration 00430)

00277 created `create_booking` with NO explicit grant ⇒ PostgreSQL default
`EXECUTE` to PUBLIC. Its sole live caller was deleted in STEP D. 00430
`revoke execute on function public.create_booking(<21-arg sig quoted
verbatim from 00277:236-259>) from public, anon, authenticated,
service_role;` then `notify pgrst, 'reload schema';`. **Revoke, NOT drop**
— forward-only, reversible (a `grant … to service_role` re-enables it if a
regression ever needs it), consistent with the workstream norm; the
definition is kept for archaeological traceability (historical migrations'
comments + the combined-RPC body's "Mirrors create_booking RPC body at
00277:278-296" provenance reference it). The brief's "20-arg" shorthand
undercounts by one — the real signature is 7 required + 14 defaulted = 21
args; the migration lists all 21 types in order (verified against source).
