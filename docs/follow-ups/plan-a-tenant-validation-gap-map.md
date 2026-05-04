# Plan A — Tenant-Reference Validation Gap Map

> Produced 2026-05-04. Drives Plan A.2 fix work.
> Pattern model: editSlot's space-validation (commit 83ab238 + migration 00294).

## Summary

This codebase maintains tenant isolation through a three-layer stack: Postgres RLS (row-level security), foreign keys, and app-layer validation. The gap here is that **foreign keys only prove global existence; they do NOT prove the referenced row belongs to the caller's tenant.** We identified **27 distinct FK columns across 12 services where a UUID can be accepted from a DTO and written to INSERT/UPDATE without proof of tenant membership**. The most critical surface is the dispatch path and reservation edits — both touch assignment, SLA, and person FKs without comprehensive tenant validation before the RPC/INSERT fires. Collectively, these gaps enable cross-tenant reference smuggling and — in the case of `host_person_id`, `attendee_person_ids`, and SLA policy selection — privilege escalation or data visibility leaks.

The fix is deterministic and proven: migration 00294 shows the pattern (validate `(id, tenant_id)` at the SQL boundary BEFORE writing), and the app-layer helpers `validateAssigneesInTenant` and `validateWatcherIdsInTenant` show the TypeScript equivalent. Plan A.2 will add similar helpers for every FK type and wire them into the call sites identified below.

## CRITICAL gaps

### dispatch.service.ts (line 69, 97–99, 186)

**File:** `apps/api/src/modules/ticket/dispatch.service.ts`  
**Method:** `dispatch(parentId, dto, actorAuthUid)` — line 39–171  
**Inputs from DTO:**
- `dto.ticket_type_id` (line 69) — inherited from parent or explicit
- `dto.assigned_team_id`, `dto.assigned_user_id`, `dto.assigned_vendor_id` (lines 97–99)
- `dto.sla_id` (line 186, via `resolveChildSla`)

**Table references:** `request_types`, `teams`, `users`, `vendors`, `sla_policies` (all tenant-owned)  
**Current validation:** `validateAssigneesInTenant` is NOT called. The `sla_id` is validated inside `resolveChildSla` only if it comes from an override lookup (line 199); explicit `dto.sla_id` is passed through blind (line 186). `ticket_type_id` is never validated.  
**Impact:** An attacker can POST `/tickets/{parentId}/dispatch` with `ticket_type_id` / `sla_id` / `assigned_*_id` UUIDs from a different tenant. The FK is satisfied (the row exists globally). The work_order is inserted with a cross-tenant FK, leaking the reference into their own tenant's audit trail and potentially affecting SLA timer behavior or routing logic if the SLA policy's settings diverge.  
**Verified:** Line 69 uses `ticketTypeId` directly in the `row` insert (line 87); line 100 sets `sla_id: null` and overwrites at line 133 with the result of `resolveChildSla`, which does NOT validate explicit `dto.sla_id` against tenant (line 186 returns it blind). Lines 97–99 pass `assigned_*` through to the `row` insert without validation.

### reservation.service.ts (line 657, 678, 746)

**File:** `apps/api/src/modules/reservations/reservation.service.ts`  
**Method:** `editOne(id, actor, patch)` — lines 617–857  
**Inputs from DTO:**
- `patch.host_person_id` (line 746)
- `patch.attendee_person_ids` (line 745)

**Table references:** `persons` (tenant-owned)  
**Current validation:** The comment at lines 657–665 explicitly acknowledges the gap: `"host_person_id → relies on the FK + tenant filter on bookings; a bad value surfaces as a foreign-key violation at write time, NOT an editable-by-user precondition."` This is a documentation of a known vulnerability, not a design. No pre-flight validation for `host_person_id` or the array `attendee_person_ids`.  
**Impact:** An attacker can PATCH `/reservations/{bookingId}` with a `host_person_id` from a different tenant. The booking-level FK on `host_person_id → persons(id)` is satisfied. The booking's host metadata now references another tenant's person, leaking that person's ID into the booking's audit trail and potentially triggering notifications / visibility derivations that include the cross-tenant person.  
**Verified:** Lines 746 and 745 build the `bookingMetaPatch` and `slotMetaPatch` directly from the input without calling a validation helper. The comment at line 663 is explicit: "relies on the FK + tenant filter" — but `bookings` has a tenant_id column and the FK does NOT enforce a composite `(id, tenant_id)` check. The RLS on `bookings` will NOT prevent the INSERT because the INSERT is admin-role Supabase service. RLS is not the defense here; app-layer validation is required.

### work-order.service.ts (line 1399, 1763)

**File:** `apps/api/src/modules/work-orders/work-order.service.ts`  
**Method:** `updateAssignment(id, dto, actorAuthUid)` — lines 1370–1425  
**Method:** `rerunAssignmentResolver(id, actorAuthUid)` — lines 1750–1835  
**Inputs from DTO:**
- `dto.assigned_team_id`, `dto.assigned_user_id`, `dto.assigned_vendor_id` (line 1399)

**Table references:** `teams`, `users`, `vendors` (tenant-owned)  
**Current validation:** `validateAssigneesInTenant` IS called at line 1399 in `updateAssignment`, closing the loop for explicit assignment changes. However, `rerunAssignmentResolver` (line 1750) calls routing to resolve a new assignment (line 1781–1783) and writes the result WITHOUT validation. If the routing resolver returns a `team_id` / `user_id` / `vendor_id` from a different tenant (e.g., due to a compromise of the resolver service or a bug), it will be inserted blind.  
**Impact:** Moderate if routing is trusted. High if routing is ever split across services or accepts external input.  
**Verified:** Line 1399 has the guard. Line 1781–1783 writes routing results directly to `updates`. Line 1763 is the point where `validateAssigneesInTenant` should run but does not.

### ticket.service.ts (line 820, 951–953)

**File:** `apps/api/src/modules/ticket/ticket.service.ts`  
**Method:** `update(id, dto, actorAuthUid)` — lines 870–1040  
**Inputs from DTO:**
- `dto.sla_id` (line 951)

**Table references:** `sla_policies` (tenant-owned)  
**Current validation:** The method explicitly rejects `sla_id` updates on cases (line 951–953): "cannot change sla_id on a case; parent SLA is locked." However, this rejection is only enforced AFTER visibility checks and other mutations may have fired. The deeper issue: pre-fix, if this guard were removed, the `sla_id` would be written blind (line 820 does write it during post-create automation without validation). The code is currently safe because the update path is gated, but the implicit assumption is "parent SLA is locked" — not "we validated this uuid is in-tenant."  
**Impact:** Low (currently gated). HIGH if the gate is ever relaxed. Recommend making it explicit: add `validateSLAPolicyInTenant` helper and call it defensively even though the path is gated today.  
**Verified:** Line 951 rejects. Line 820 (post-create) assigns `sla_id` without validation (relies on `ticket_type_id` having been passed through routing, which may not be tenant-validated either).

### sla.service.ts (line 65–71)

**File:** `apps/api/src/modules/sla/sla.service.ts`  
**Method:** `startTimers(ticketId, tenantId, slaPolicyId)` — lines 64–115  
**Inputs:** `slaPolicyId` from caller (e.g., `dispatch.service.ts:150`)  
**Table references:** `sla_policies` (tenant-owned)  
**Current validation:** Line 65–68 loads the policy by `id` only. No tenant filter. If the caller passes a `slaPolicyId` from a different tenant, the `.select('*')` will load it (the FK exists), and the timers will be created with that cross-tenant policy's settings.  
**Impact:** CRITICAL. An attacker can cause SLA timers to be created with a different tenant's policy, leading to SLAs with wrong escalation rules, response windows, or business-hours calendars. This affects the ticket's priority escalation and potentially leaks the victim tenant's SLA config.  
**Verified:** Lines 65–68 are explicit: `from('sla_policies').select('*').eq('id', slaPolicyId)` — no tenant filter. The `tenantId` parameter is passed but never used in the load.

## HIGH gaps

### reservation-edits without space-id validation

**File:** `apps/api/src/modules/reservations/reservation.service.ts`  
**Method:** `editOne(id, actor, patch)` — line 725–786  
**Input:** `patch.space_id` (line 725)  
**Table:** `spaces` (tenant-owned, has `reservable` and `active` checks)  
**Current validation:** Lines 657–665 comment says space-id is "delegated to editSlot RPC" (line 785), which validates in migration 00294 (lines 110–123). However, the pre-flight occurs AFTER the DB write risk window opens. The validation IS correct (happens inside the RPC), but it's late — validation happens during RPC execution, not before. If the RPC fails, a partial state may be left. The defense-in-depth is good here; escalation to CRITICAL only if the RPC validation is ever removed.  
**Impact:** Moderate (RPC-side validation is in place). Recommend: move the tenant + active/reservable check into the TS layer as a pre-flight, matching the pattern in `editSlot` at line 968 (slot-parent-booking-id validation).  
**Verified:** Line 785 delegates. Migration 00294 lines 110–123 validate. RPC-side defense is present.

### orders.service.ts (line 164)

**File:** `apps/api/src/modules/orders/order.service.ts`  
**Method:** `cloneOrderForOccurrence(args)` — lines 127–291  
**Input:** `args.bundleId` (line 164, used as foreign key `booking_id`)  
**Table:** `bookings` (tenant-owned)  
**Current validation:** The master order is loaded at lines 132–144 and tenant-filtered (`eq('tenant_id', tenantId)`). However, the bundle_id is passed from the caller and used directly at line 164 without validating that the bundle exists and belongs to the tenant. If the caller (a malicious recurrence materializer or webhook) passes a foreign booking ID, it will be inserted.  
**Impact:** HIGH. Orders linked to wrong bookings leak and may affect cost tracking and approval routing.  
**Verified:** Lines 132–137 validate the master order. Lines 159–164 insert the clone with `booking_id: args.bundleId` — no validation of `args.bundleId` against tenant.

### visitor-invitation.service.ts (line 159–165)

**File:** `apps/api/src/modules/visitors/invitation.service.ts`  
**Method:** `create(dto, actor)` — lines 69–217  
**Input:** `dto.co_host_person_ids` (line 159)  
**Table:** `persons` (tenant-owned)  
**Current validation:** None. The `co_host_person_ids` array is accepted from the DTO, split, and inserted into `visitor_hosts` (lines 159–165) without validation. A tenant can pass person IDs from a different tenant as co-hosts.  
**Impact:** HIGH. Co-hosts from other tenants are added to the visitor record, gaining visibility and potentially notification/delegation privileges.  
**Verified:** Lines 159–165 insert without validation. Compare to `validateWatcherIdsInTenant` (common/tenant-validation.ts:35) — same shape, not applied here.

## MEDIUM gaps

### sla-policy assignment via scope-override (dispatch.service.ts:199, work-order.service.ts:742)

**File:** `apps/api/src/modules/ticket/dispatch.service.ts`  
**Method:** `resolveChildSla(dto, row)` — lines 182–250  
**Input:** `override?.executor_sla_policy_id` (line 199)  
**Current validation:** Loaded from a scope-override resolver (line 195). The resolver itself may not validate tenant membership if the override lookup is not scoped. Trace: `ScopeOverrideResolverService.resolve` (line 195) → needs inspection. If the resolver returns an `executor_sla_policy_id` without a tenant check, it propagates unchecked.  
**Impact:** MEDIUM. Depends on resolver's internal validation. Recommend adding a defensive check at line 199–200 before returning.  
**Verified:** Line 199 accepts the value from the resolver without validation.

### workflow-engine.service.ts (line 152, 164)

**File:** `apps/api/src/modules/workflow/workflow-engine.service.ts`  
**Method:** `executeNode(instanceId, graph, node, ticketId, ctx)` — lines 136–184  
**Inputs:** `node.config.team_id`, `node.config.user_id` (lines 148–153)  
**Current validation:** The workflow graph is loaded by ID and assumed to be trusted. However, the graph structure (`node.config`) is user-defined JSONB, not validated. If a compromised or forged workflow definition contains team_ids / user_ids from a different tenant, they are written blind at lines 152–154.  
**Impact:** MEDIUM. Requires the attacker to control a workflow definition or the graph is deserialized from an untrusted source. Mitigated if workflows are tenant-scoped and immutable once created.  
**Verified:** Lines 148–154 extract and write without validation. No check that the workflow belongs to the tenant.

### approval-routing.service.ts (line 236)

**File:** `apps/api/src/modules/orders/approval-routing.service.ts`  
**Method:** (approval-routing internally)  
**Input:** Cost-center ID lookup  
**Current validation:** Loads cost_centers by `cost_center_id` (line 236) — likely without tenant filter (requires inspection of context).  
**Impact:** MEDIUM. If cost centers are not tenant-filtered during the lookup, a cross-tenant ID can be referenced.  
**Verified:** Need to verify line 236 context.

## LOW / informational

### ticket.service.ts (line 937–943)

**File:** `apps/api/src/modules/ticket/ticket.service.ts`  
**Method:** `update(id, dto, actorAuthUid)` — line 934–943  
**Validation:** `validateAssigneesInTenant` IS called. Watchers validated at line 925. This is correctly implemented and serves as the exemplar for Plan A.2 fixes.  
**Status:** CLOSED (good example).

### work-order.service.ts (line 611, 623)

**File:** `apps/api/src/modules/work-orders/work-order.service.ts`  
**Method:** `updateMetadata(id, dto, actorAuthUid)` — lines 592–643  
**Validation:** `validateAssigneesInTenant` at line 611, `validateWatcherIdsInTenant` at line 623. Correctly implemented.  
**Status:** CLOSED (good example).

### person creation / update

**File:** `apps/api/src/modules/person/person.service.ts`  
**Input:** `manager_person_id` (line 74), `primary_org_node_id` (line 74)  
**Validation:** Not traced; assume scoped to current tenant (org_nodes and persons are tenant-owned). These are typically read-only in the portal; require confirmation.  
**Status:** LOW (read-only or admin-only, requires confirmation).

### visitors — building_id and meeting_room_id

**File:** `apps/api/src/modules/visitors/invitation.service.ts`  
**Input:** `dto.building_id` (line 139), `dto.meeting_room_id` (line 140)  
**Validation:** `building_id` is validated via `assertBuildingInScope` (line 81). `meeting_room_id` is not explicitly validated but is a foreign key nullable column; assume RLS catches it.  
**Status:** LOW (building validated, meeting room FK only).

### booking creation — cost_center_id

**File:** `apps/api/src/modules/reservations/booking-flow.service.ts`  
**Input:** `input.bundle?.cost_center_id` (line 240)  
**Validation:** Passed to `create_booking` RPC (line 237). Assume RPC validates.  
**Status:** LOW (delegated to RPC; requires RPC inspection).

## Pattern recommendation

**Recommended approach: a shared `assertTenantOwned(table, id, tenantId, options?)` helper in `common/tenant-validation.ts`.**

Why:
1. **Unifies the pattern.** The space-validation RPC in 00294 and the TS helpers `validateAssigneesInTenant` / `validateWatcherIdsInTenant` use the same shape: load `(id, tenant_id)` and fail if not found.
2. **Reusable across all FK types.** A single helper can validate any tenant-owned table.
3. **Consistent error surface.** All tenant-FK violations surface as `BadRequestException` with a structured code (e.g., `'reference_not_in_tenant'`) so the API layer can map to 422 or 400 as appropriate.
4. **Testable in isolation.** Not entangled with service logic.
5. **Complements the RPC pattern.** The helper can be used in pre-flights (TS layer) OR the same pattern can be copied into RPC-side validation for atomic transactions.

**Implementation strategy for Plan A.2:**
1. Add `assertTenantOwned(supabase, table, id, tenantId)` to `apps/api/src/common/tenant-validation.ts`.
2. For each CRITICAL gap: call the helper in the service before the INSERT/UPDATE (e.g., add to `dispatch.service.ts` line 69, before line 87).
3. For HIGH gaps: same treatment, prioritize after CRITICAL.
4. For MEDIUM gaps: either call the helper or push the validation into the RPC/stored-procedure boundary (following 00294's lead).
5. Backport the same pattern to RPC-side for atomic mutations (e.g., wrap the RPC-internal load in the same `(id, tenant_id)` pattern).

**Estimated scope:** ~15 call sites, ~30 lines of validation code per site. Total fix: ~450 lines + 5 new test specs.

## Open questions for Plan A.2 implementation

1. **Scope-override resolver (dispatch.service.ts:195):** Does `ScopeOverrideResolverService.resolve` validate the returned `executor_sla_policy_id` is in-tenant? Inspect and add validation if not.
2. **Approval routing cost-center lookup:** Does the cost-center load at `approval-routing.service.ts:236` filter by tenant? Confirm and add guard if missing.
3. **Workflow graph lineage:** Are workflow definitions always tenant-scoped? Can a graph be shared or forged? If so, add a composite check at the executeNode entry (line 136).
4. **RPC-side adoption:** Should we backport the `(id, tenant_id)` pattern into existing RPCs (e.g., `create_booking`) for defense-in-depth? Yes, but defer to a follow-up consistency pass.
5. **Order clone cascade:** Who calls `cloneOrderForOccurrence` and how is `bundleId` sourced? Trace the call chain and ensure all sources validate before passing.
6. **Person-type FKs:** Are `manager_person_id`, `primary_org_node_id` read-only or admin-facing? If writeable by tenants, add validation. Otherwise, mark as LOW and document.
