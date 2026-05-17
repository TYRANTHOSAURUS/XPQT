import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors } from '../../common/errors';
import { TenantContext } from '../../common/tenant-context';
import {
  loadPermissionMap,
  loadRequesterContext,
} from '../../common/requester-context';
import { ApprovalRoutingService } from '../orders/approval-routing.service';
import { ServiceRuleResolverService } from '../service-catalog/service-rule-resolver.service';
import { buildServiceEvaluationContext } from '../service-catalog/service-evaluation-context';
import { BundleEventBus, type BundleEvent } from './bundle-event-bus';
import type { BundleSource, BundleType } from './dto/types';
import type {
  AttachPlan,
  AttachPlanAssetReservation,
  AttachPlanOrder,
  AttachPlanOrderLineItem,
  AttachPlanSetupEmit,
  BundleAuditPayload,
} from './attach-plan.types';
import { planUuid } from './plan-uuid';
import { buildAttachServicesIdempotencyKey } from '@prequest/shared';
import {
  comparePlanAssetReservations,
  comparePlanOrderLineItems,
  comparePlanOrders,
} from './plan-sort';

/**
 * BundleService — orchestration parent for booking + N services.
 *
 * Post-canonicalisation (2026-05-02): there is no separate `booking_bundles`
 * row. The `bookings` row IS the canonical entity (00277:27). This service
 * attaches service orders/lines/asset-reservations to an existing booking.
 *
 * Responsibilities:
 *   - Group service lines by service_type → one order per group.
 *   - Insert order_line_items with provenance snapshot from `resolve_menu_offer`.
 *   - Insert asset_reservations when a line linked an asset (GiST exclusion
 *     fires here on conflict).
 *   - Resolve service rules + assemble approvals via the deduping
 *     `ApprovalRoutingService`.
 *   - Emit `booking.services_attached` / cascade events as the bundle event
 *     bus expects them (event names retain `bundle.*` for now — bus subscribers
 *     are out-of-scope slices).
 *
 * Atomicity (v1):
 *   Booking creation itself is now atomic via the `create_booking` RPC
 *   (00277:236) — the booking + slot rows go in inside one transaction.
 *   Service attachment (this service) still uses a sequence of Supabase
 *   calls with explicit cleanup-on-error. Asset GiST exclusion still fires
 *   at insert time so dual-bookings are impossible. A future refactor will
 *   pull the whole pipeline into a single Postgres function.
 *
 * Method rename:
 *   - `attachServicesToReservation` → `attachServicesToBooking`. The legacy
 *     name remains as a deprecated shim that delegates to the new method,
 *     translating the renamed `reservation_id` field to `booking_id`. Per the
 *     destructive-default rewrite plan, the legacy method will be removed
 *     once `reservation.controller.ts` migrates (separate slice).
 */

export interface AttachServicesArgs {
  /**
   * The id of an existing `bookings` row (00277:28) to attach services to.
   * Field renamed from `reservation_id` post-canonicalisation; the legacy
   * `attachServicesToReservation` shim accepts the old field name and
   * translates here.
   */
  booking_id: string;
  requester_person_id: string;
  bundle?: {
    bundle_type?: BundleType;
    host_person_id?: string | null;
    cost_center_id?: string | null;
    template_id?: string | null;
    source?: BundleSource;
  };
  services: ServiceLineInput[];
  /**
   * Caller-supplied stable retry id (X-Client-Request-Id, threaded by the
   * controller — RequireClientRequestIdGuard enforces presence at the HTTP
   * boundary). Drives both the deterministic `buildAttachPlan` UUIDs AND
   * the `attach_services_to_existing_booking` RPC's `attach_operations`
   * idempotency key. Booking-audit Slice 5: required for the atomic-RPC
   * cutover (the legacy non-atomic N-write + Cleanup path is gone). The
   * service hard-fails if absent (mirrors ReservationService.cancelOne:488).
   */
  client_request_id?: string;
}

/**
 * Legacy shape kept ONLY for the deprecated `attachServicesToReservation`
 * shim. New callers must use `AttachServicesArgs` + `attachServicesToBooking`.
 */
export interface AttachServicesToReservationArgsDeprecated {
  reservation_id: string;
  requester_person_id: string;
  bundle?: {
    bundle_type?: BundleType;
    host_person_id?: string | null;
    cost_center_id?: string | null;
    template_id?: string | null;
    source?: BundleSource;
  };
  services: ServiceLineInput[];
  /** See AttachServicesArgs.client_request_id (Slice 5). */
  client_request_id?: string;
}

export interface ServiceLineInput {
  catalog_item_id: string;
  menu_id?: string | null;
  quantity: number;
  /** Defaults to reservation window when omitted. */
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
  /** True (default) = clones for future occurrences; false = master-only. */
  repeats_with_series?: boolean;
  /** When set, an `asset_reservations` row is created in the same transaction. */
  linked_asset_id?: string | null;
  /**
   * REQUIRED for `buildAttachPlan` (combined-RPC path, B.0). Optional on the
   * legacy `attachServicesToBooking` path. Caller-supplied stable identifier
   * for this line within the request — typically the React form-row key, or
   * a hash of (catalog_item_id, service_window). The plan-builder rejects
   * requests where any line is missing this OR where two lines in the same
   * service-type group share the same value. Spec §7.4 v8.
   */
  client_line_id?: string;
}

/**
 * Args for `BundleService.buildAttachPlan` — the plan-only sibling of
 * `attachServicesToBooking`. The plan-builder synthesises the equivalent
 * of a `BookingRow` from the projection below — the combined RPC has not
 * yet inserted the booking, so there's no row to load.
 *
 * Spec §7.4 + §7.6 (combined RPC inputs).
 */
export interface BuildAttachPlanArgs {
  /** = booking_input.booking_id (pre-generated by the caller via planUuid). */
  booking_id: string;
  /** Tenant — passed explicitly so the plan-builder doesn't depend on TenantContext. */
  tenant_id: string;
  /** Booking projection — every field the catalog/rule resolver needs. */
  booking: {
    location_id: string;
    requester_person_id: string;
    host_person_id: string | null;
    start_at: string;
    end_at: string;
    /**
     * Pulled from the primary slot at create-time (= the slot at lowest
     * display_order). Drives per_attendee pricing in the rule resolver.
     */
    attendee_count: number | null;
    source: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence';
  };
  /**
   * Required when services is non-empty (so the line-key dedup index can
   * collide rule resolution against scope_breakdown). Keep as the same
   * canonical id used by BookingFlowService — typically the booking's
   * requester_person_id.
   */
  requester_person_id: string;
  /**
   * Bundle-level metadata that the existing `attachServicesToBooking`
   * passes through to the rule resolver context + approval routing.
   * Optional — `null` defaults are equivalent.
   */
  bundle?: {
    bundle_type?: BundleType;
    host_person_id?: string | null;
    cost_center_id?: string | null;
    template_id?: string | null;
    source?: BundleSource;
  };
  services: ServiceLineInput[];
  /**
   * Idempotency key from the request (X-Client-Request-Id, threaded by
   * middleware). Drives every `planUuid` call inside the builder so two
   * retries with the same key produce byte-identical jsonb. Spec §7.4.
   */
  idempotency_key: string;
}

export interface AttachServicesResult {
  /**
   * Equals `args.booking_id`. Kept under the `bundle_id` field name for
   * backwards-compat with controllers/UI that still read `bundle_id` —
   * under canonicalisation the booking IS the bundle. Renamed in a
   * follow-up frontend slice.
   */
  bundle_id: string;
  order_ids: string[];
  order_line_item_ids: string[];
  asset_reservation_ids: string[];
  approval_ids: string[];
  any_pending_approval: boolean;
}

@Injectable()
export class BundleService {
  private readonly log = new Logger(BundleService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: ServiceRuleResolverService,
    private readonly approvalRouter: ApprovalRoutingService,
    private readonly eventBus: BundleEventBus,
  ) {}

  /**
   * Deprecated legacy entry-point. Translates the old `reservation_id` field
   * to the new canonical `booking_id` and delegates to
   * `attachServicesToBooking`.
   *
   * Kept ONLY so `reservation.controller.ts` (separate slice) keeps
   * typechecking. The controller currently passes the URL `:id` segment as
   * `reservation_id`; that param is now semantically a booking id (the
   * URL path will be renamed in the controller-rewrite slice). Until then,
   * runtime correctness depends on callers passing a real booking id.
   *
   * @deprecated Use `attachServicesToBooking({ booking_id, ... })` directly.
   */
  async attachServicesToReservation(
    args: AttachServicesToReservationArgsDeprecated,
  ): Promise<AttachServicesResult> {
    return this.attachServicesToBooking({
      booking_id: args.reservation_id,
      requester_person_id: args.requester_person_id,
      bundle: args.bundle,
      services: args.services,
      client_request_id: args.client_request_id,
    });
  }

  /**
   * The canonical "attach N services to an existing booking" path. Called
   * from `BookingFlowService.create` after the `create_booking` RPC lands
   * the booking + slot rows, and from the standalone-order pipeline
   * (with a pre-existing booking, if any).
   */
  async attachServicesToBooking(args: AttachServicesArgs): Promise<AttachServicesResult> {
    if (args.services.length === 0) {
      throw AppErrors.validationFailed('bundle.no_services', { detail: 'no service lines provided' });
    }
    const tenantId = TenantContext.current().id;

    // Booking-audit Slice 5 (audit 03 P1-3): the legacy non-atomic N-write
    // path + reverse-order TS `Cleanup` undo-queue (same data-loss class as
    // the P0-1 cancel bug) is RETIRED. The attach is now ONE atomic
    // PL/pgSQL RPC — `attach_services_to_existing_booking` (00412), which
    // mirrors the attach half of the LIVE create_booking_with_attach_plan
    // WITHOUT booking/slot creation. Postgres transaction atomicity
    // replaces the in-process compensation: any partial-write rolls back
    // with the attach_operations marker, so a deny / FK miss / GiST
    // conflict leaves ZERO orphan rows.
    //
    // X-Client-Request-Id is the idempotency boundary. The controller's
    // RequireClientRequestIdGuard enforces presence at the HTTP boundary;
    // this service-layer hard-fail enforces it for any internal caller
    // (mirrors ReservationService.cancelOne:488 — F-CRIT-1).
    const clientRequestId = args.client_request_id;
    if (!clientRequestId) {
      throw AppErrors.server('command_operations.unexpected_state', {
        detail:
          'attachServicesToBooking reached the RPC layer with no client_request_id ' +
          'despite RequireClientRequestIdGuard (booking-audit Slice 5).',
      });
    }

    // Verify the booking exists in this tenant (clean 404 + the projection
    // the pure plan-builder needs). loadBooking is tenant-scoped (#0).
    const booking = await this.loadBooking(args.booking_id);
    const bundleId = booking.id; // booking IS the bundle (00277:27)

    const idempotencyKey = buildAttachServicesIdempotencyKey(
      args.booking_id,
      clientRequestId,
    );

    // Reuse the EXISTING pure/deterministic plan-builder (every UUID via
    // planUuid(idempotencyKey) — bundle.service.ts buildAttachPlan). Same
    // builder the combined-create + multi-room paths use; identical
    // (booking, services, idempotency_key) → byte-identical jsonb, so a
    // same-key replay hashes identically inside the RPC's attach_operations
    // gate (the determinism contract the smoke gate's probe (b) verifies).
    const attachPlan = await this.buildAttachPlan({
      booking_id: args.booking_id,
      tenant_id: tenantId,
      booking: {
        location_id: booking.space_id,
        requester_person_id: booking.requester_person_id,
        host_person_id: booking.host_person_id,
        start_at: booking.start_at,
        end_at: booking.end_at,
        attendee_count: booking.attendee_count,
        source: (booking.source ??
          'desk') as BuildAttachPlanArgs['booking']['source'],
      },
      requester_person_id: args.requester_person_id,
      bundle: args.bundle,
      services: args.services,
      idempotency_key: idempotencyKey,
    });

    // ── Atomic RPC ─────────────────────────────────────────────────────
    const { data: rpcData, error: rpcError } = await this.supabase.admin.rpc(
      'attach_services_to_existing_booking',
      {
        p_booking_id: args.booking_id,
        p_attach_plan: attachPlan as unknown as Record<string, unknown>,
        p_tenant_id: tenantId,
        p_idempotency_key: idempotencyKey,
      },
    );

    if (rpcError) {
      throw this.mapAttachRpcError(rpcError);
    }

    const result = (rpcData ?? null) as
      | {
          booking_id: string;
          order_ids: string[];
          order_line_item_ids: string[];
          asset_reservation_ids: string[];
          approval_ids: string[];
          any_pending_approval: boolean;
        }
      | null;
    if (!result?.booking_id) {
      throw AppErrors.server('booking.unexpected_error', {
        detail: 'attach_services_to_existing_booking returned no booking_id',
      });
    }

    // Post-commit best-effort audit (mirrors the create path's
    // void this.audit(...) at booking-flow.service.ts:622 — the RPC already
    // committed; an audit-insert failure must NOT roll the attach back).
    void this.audit(tenantId, 'bundle.created', 'booking_bundle', bundleId, {
      bundle_id: bundleId,
      booking_id: bundleId,
      order_ids: result.order_ids,
      order_line_item_ids: result.order_line_item_ids,
      asset_reservation_ids: result.asset_reservation_ids,
      approval_ids: result.approval_ids,
      any_pending_approval: result.any_pending_approval,
      via: 'attach_services_to_existing_booking',
      idempotency_key: idempotencyKey,
    });

    return {
      bundle_id: bundleId,
      order_ids: result.order_ids,
      order_line_item_ids: result.order_line_item_ids,
      asset_reservation_ids: result.asset_reservation_ids,
      approval_ids: result.approval_ids,
      any_pending_approval: result.any_pending_approval,
    };
  }

  /**
   * Map a PostgREST `attach_services_to_existing_booking` RPC error to the
   * appropriate AppError. Mirrors `BookingFlowService.mapAttachPlanRpcError`
   * (booking-flow.service.ts:671-776) one-for-one — the new RPC raises the
   * SAME error strings as the live create RPC's attach half (it IS that
   * half), so every code reused here is already registered in
   * packages/shared/src/error-codes.ts (no new error codes — verified):
   *   - 23P01 GiST exclusion (asset_reservations_no_overlap) →
   *     `asset_conflict` 409 (the picker surfaces alternatives upstream).
   *   - `attach_operations.payload_mismatch` (P0001) →
   *     `booking.idempotency_payload_mismatch` 409.
   *   - `attach_plan.fk_invalid: …` (42501, validate_attach_plan_tenant_fks)
   *     → `booking.fk_invalid` 422.
   *   - `attach_plan.internal_refs: …` (42501 snapshot-uuid variant) →
   *     `booking.snapshot_uuid_invalid` 422; (other) →
   *     `booking.internal_ref_invalid` 422.
   *   - `service_rule_deny: …` (P0001) → `service_rule_deny` 422.
   *   - `attach_services_to_existing_booking.booking_not_found` (P0001) →
   *     `booking` notFound 404 (the loadBooking pre-check normally catches
   *     this first; the RPC raise is the defense-in-depth path).
   *   - anything else → `booking.unexpected_error` 500 (raw message logged;
   *     the SAME catch-all code the create path uses — no new error code).
   */
  private mapAttachRpcError(rpcError: { code?: string; message?: string }): Error {
    const code = rpcError.code ?? '';
    const message = rpcError.message ?? '';

    if (code === '23P01' || isExclusionViolation(rpcError)) {
      return AppErrors.conflict('asset_conflict', {
        detail: 'A requested asset is already reserved for this window.',
      });
    }
    if (message.includes('attach_operations.payload_mismatch')) {
      return AppErrors.conflict('booking.idempotency_payload_mismatch', {
        detail:
          'A retry of this service attach arrived with different content. ' +
          'Re-submit with a fresh request id, or refresh and try again.',
      });
    }
    if (message.includes('attach_plan.fk_invalid')) {
      return AppErrors.validationFailed('booking.fk_invalid', {
        detail: this.extractRaiseMessage(message),
      });
    }
    if (message.includes('attach_plan.internal_refs') && code === '42501') {
      return AppErrors.validationFailed('booking.snapshot_uuid_invalid', {
        detail: this.extractRaiseMessage(message),
      });
    }
    if (message.includes('attach_plan.internal_refs')) {
      return AppErrors.validationFailed('booking.internal_ref_invalid', {
        detail: this.extractRaiseMessage(message),
      });
    }
    if (message.includes('service_rule_deny')) {
      return AppErrors.validationFailed('service_rule_deny', {
        detail: this.extractRaiseMessage(message),
      });
    }
    if (message.includes('attach_services_to_existing_booking.booking_not_found')) {
      return AppErrors.notFound('booking', this.extractRaiseMessage(message));
    }
    this.log.error(
      `attach_services_to_existing_booking unexpected error: code=${code} message=${message}`,
    );
    return AppErrors.server('booking.unexpected_error', {
      detail: message || 'Unexpected error during service attach.',
    });
  }

  /** Strip the `prefix: ` of a RAISE EXCEPTION message (mirrors
   *  BookingFlowService.extractRaiseMessage at booking-flow.service.ts:780). */
  private extractRaiseMessage(raw: string): string {
    const idx = raw.indexOf(': ');
    return idx >= 0 ? raw.slice(idx + 2) : raw;
  }

  /**
   * `buildAttachPlan` — pure plan-builder for the combined-RPC path
   * (`create_booking_with_attach_plan`). Mirrors the rule-resolver +
   * cost + asset-reservation + approval-routing logic in
   * `attachServicesToBooking` but does NOT write to the database. The
   * combined RPC inserts every row atomically.
   *
   * Spec: §7.4 (AttachPlan shape), §7.5 (assemblePlan rationale), §7.6
   * (combined RPC body) of
   * docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
   *
   * Hard rules (v8):
   *   - Every input line MUST have a non-empty, per-service-type-unique
   *     `client_line_id`. Throws `BadRequestException(client_line_id_*)`
   *     before any UUID is generated.
   *   - Every UUID is derived from `idempotency_key` via `planUuid()`. Two
   *     retries of the same logical request produce byte-identical jsonb.
   *   - Every row collection is sorted with `planSort.*` BEFORE stableIndex
   *     assignment. Caller iteration order MUST NOT leak into the hash.
   *   - When `any_pending_approval=true`, lines requiring internal setup
   *     get `pending_setup_trigger_args` populated (so
   *     `approve_booking_setup_trigger` can re-emit on grant) AND
   *     `setup_emit` is omitted (the RPC's defense-in-depth gate skips
   *     emission anyway, but the plan-builder also gates).
   *   - `any_deny=true` short-circuits the RPC (raises `service_rule_deny`
   *     before any insert); the plan still ships with the deny_messages
   *     populated for the surfaced error.
   *
   * Dormant in B.0.C — `BookingFlowService.create` keeps using
   * `attachServicesToBooking` until B.0.D rewires the call site.
   */
  async buildAttachPlan(args: BuildAttachPlanArgs): Promise<AttachPlan> {
    if (!args.idempotency_key || args.idempotency_key.length === 0) {
      throw AppErrors.validationFailed('bundle.idempotency_key_required', {
        detail: 'buildAttachPlan: idempotency_key required.',
      });
    }
    if (!args.tenant_id) {
      throw AppErrors.validationFailed('bundle.tenant_id_required', {
        detail: 'buildAttachPlan: tenant_id required.',
      });
    }

    // Empty-services plan: ships with empty arrays + any_pending_approval=false.
    // The combined RPC accepts this for plain room bookings (no catering / AV).
    if (args.services.length === 0) {
      return {
        version: 1,
        any_pending_approval: false,
        any_deny: false,
        deny_messages: [],
        orders: [],
        asset_reservations: [],
        order_line_items: [],
        approvals: [],
        bundle_audit_payload: {
          bundle_id: args.booking_id,
          booking_id: args.booking_id,
          order_ids: [],
          order_line_item_ids: [],
          asset_reservation_ids: [],
          approval_ids: [],
          any_pending_approval: false,
        },
      };
    }

    // ── 1. Validate client_line_id presence + per-service-type uniqueness ──
    // The uniqueness scope is per service-type group (= per order). We
    // don't know the service_type until hydration, but a per-input duplicate
    // (two lines with the same client_line_id in the input array) is
    // pathological regardless. Validate global uniqueness first, then revisit
    // after hydration.
    const seenLineIds = new Set<string>();
    for (const line of args.services) {
      const id = (line.client_line_id ?? '').trim();
      if (!id) {
        throw AppErrors.validationFailed('client_line_id_required', {
          detail: 'buildAttachPlan: every service line must have a non-empty client_line_id.',
        });
      }
      if (seenLineIds.has(id)) {
        throw AppErrors.validationFailed('client_line_id_not_unique', {
          detail: `buildAttachPlan: duplicate client_line_id "${id}" — each line must have a unique id.`,
        });
      }
      seenLineIds.add(id);
    }

    // ── 2. Synthesize a BookingRow for the existing helpers ────────────────
    const booking: BookingRow = {
      id: args.booking_id,
      tenant_id: args.tenant_id,
      space_id: args.booking.location_id,
      requester_person_id: args.booking.requester_person_id,
      host_person_id: args.booking.host_person_id,
      start_at: args.booking.start_at,
      end_at: args.booking.end_at,
      attendee_count: args.booking.attendee_count,
      booking_bundle_id: args.booking_id,         // booking IS the bundle
      source: args.booking.source,
    };

    // ── 3. Hydrate lines (catalog lookup + menu offer + lead-time guard) ──
    const lines = await this.hydrateLines(args.services, booking);
    // Re-verify per-service-type uniqueness now that we know each line's
    // service_type (the per-order scope mandated by §7.4 v8).
    const lineIdByServiceType = new Map<string, Set<string>>();
    for (let i = 0; i < lines.length; i++) {
      const cid = (args.services[i].client_line_id ?? '').trim();
      const serviceType = lines[i].service_type;
      const set = lineIdByServiceType.get(serviceType) ?? new Set<string>();
      if (set.has(cid)) {
        throw AppErrors.validationFailed('client_line_id_not_unique', {
          detail: `buildAttachPlan: duplicate client_line_id "${cid}" within service_type "${serviceType}".`,
        });
      }
      set.add(cid);
      lineIdByServiceType.set(serviceType, set);
    }

    const requesterCtx = await loadRequesterContext(this.supabase, args.requester_person_id, args.tenant_id);
    const permissions = await loadPermissionMap(this.supabase, requesterCtx.user_id, args.tenant_id);

    // ── 4. Group lines by service_type (one order per group) ───────────────
    const linesByServiceType = new Map<string, HydratedLine[]>();
    const clientIdByLineIndex: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const list = linesByServiceType.get(lines[i].service_type) ?? [];
      list.push(lines[i]);
      linesByServiceType.set(lines[i].service_type, list);
      clientIdByLineIndex.push((args.services[i].client_line_id ?? '').trim());
    }
    // Map back from a hydrated line → its caller-supplied client_line_id.
    const clientIdByLine = new Map<HydratedLine, string>();
    for (let i = 0; i < lines.length; i++) {
      clientIdByLine.set(lines[i], clientIdByLineIndex[i]);
    }

    // ── 5. Build orders (deterministic UUIDs; one per service_type) ────────
    const planOrders: AttachPlanOrder[] = [];
    const orderIdByServiceType = new Map<string, string>();
    const initialStatusPlaceholder: 'submitted' | 'approved' = 'approved';
    for (const serviceType of linesByServiceType.keys()) {
      const orderId = planUuid(args.idempotency_key, 'order', serviceType);
      orderIdByServiceType.set(serviceType, orderId);
      planOrders.push({
        id: orderId,
        service_type: serviceType,
        requester_person_id: args.requester_person_id,
        delivery_location_id: booking.space_id,
        delivery_date: booking.start_at.slice(0, 10),
        requested_for_start_at: booking.start_at,
        requested_for_end_at: booking.end_at,
        // Filled in below once any_pending_approval is computed; placeholder
        // here keeps the type narrow.
        initial_status: initialStatusPlaceholder,
        policy_snapshot: { service_type: serviceType },
      });
    }
    planOrders.sort(comparePlanOrders);

    // ── 6. Build OLIs + asset_reservations (per-line) ──────────────────────
    const planOlis: AttachPlanOrderLineItem[] = [];
    // Sort the asset reservations by `client_line_id` (the immutable OLI
    // sort key per §7.4 v8 row-kind table). Tracking the sort key alongside
    // the row keeps the sort deterministic without needing to plumb
    // `client_line_id` onto AttachPlanAssetReservation itself.
    const arWithSortKey: Array<{ row: AttachPlanAssetReservation; client_line_id: string }> = [];
    const lineByOliId = new Map<string, HydratedLine>();

    for (const [serviceType, group] of linesByServiceType) {
      const orderId = orderIdByServiceType.get(serviceType)!;
      for (const line of group) {
        const clientLineId = clientIdByLine.get(line)!;
        const oliId = planUuid(args.idempotency_key, 'oli', `${orderId}:${clientLineId}`);
        let assetReservationId: string | null = null;
        if (line.linked_asset_id) {
          assetReservationId = planUuid(
            args.idempotency_key,
            'asset_reservation',
            `${orderId}:${clientLineId}`,
          );
          // Tenant-scope check on the asset id — the combined RPC also
          // validates this via validate_attach_plan_tenant_fks (§8.1), but
          // failing fast in TS gives a clearer 404 than a P0001 from PG.
          await this.assertAssetInTenant(line.linked_asset_id, args.tenant_id);
          arWithSortKey.push({
            row: {
              id: assetReservationId,
              asset_id: line.linked_asset_id,
              start_at: line.service_window_start_at,
              end_at: line.service_window_end_at,
              requester_person_id: args.requester_person_id,
              booking_id: args.booking_id,
              status: 'confirmed',
            },
            client_line_id: clientLineId,
          });
        }

        planOlis.push({
          id: oliId,
          client_line_id: clientLineId,
          order_id: orderId,
          catalog_item_id: line.catalog_item_id,
          quantity: line.quantity,
          unit_price: line.unit_price,
          line_total:
            line.unit_price != null ? Number((line.unit_price * line.quantity).toFixed(2)) : null,
          fulfillment_status: 'ordered',
          fulfillment_team_id: line.fulfillment_team_id,
          vendor_id: line.fulfillment_vendor_id,
          menu_item_id: line.menu_item_id,
          linked_asset_id: line.linked_asset_id,
          linked_asset_reservation_id: assetReservationId,
          service_window_start_at: line.service_window_start_at,
          service_window_end_at: line.service_window_end_at,
          repeats_with_series: line.repeats_with_series,
          // Filled below once outcomes are resolved.
          pending_setup_trigger_args: null,
          policy_snapshot: {
            menu_id: line.menu_id,
            menu_item_id: line.menu_item_id,
            unit: line.unit,
            service_type: line.service_type,
          },
          setup_emit: null,
        });

        lineByOliId.set(oliId, line);
      }
    }
    // Canonical sort — must be stable BEFORE we plug in setup hints / args.
    planOlis.sort(comparePlanOrderLineItems);
    arWithSortKey.sort((a, b) => comparePlanAssetReservations(a, b));
    const planAssetReservations: AttachPlanAssetReservation[] = arWithSortKey.map((x) => x.row);

    // ── 7. Resolve service rules per line ──────────────────────────────────
    const orderTotal = lines.reduce(
      (sum, l) => sum + (l.unit_price ?? 0) * l.quantity,
      0,
    );
    const perLineOutcomeInputs = planOlis.map((oli) => {
      const line = lineByOliId.get(oli.id)!;
      return {
        lineKey: oli.id,
        catalog_item_id: line.catalog_item_id,
        catalog_item_category: line.catalog_item_category,
        menu_id: line.menu_id ?? null,
      };
    });

    const outcomes = await this.resolver.resolveBulk({
      lines: perLineOutcomeInputs,
      contextFor: (lineKey) => {
        const line = lineByOliId.get(lineKey);
        if (!line) throw AppErrors.server('bundle.context_lookup_failed', { detail: `context lookup failed for ${lineKey}` });
        return buildServiceEvaluationContext({
          requester: requesterCtx,
          bundle: {
            id: args.booking_id,
            cost_center_id: args.bundle?.cost_center_id ?? null,
            template_id: args.bundle?.template_id ?? null,
            attendee_count: booking.attendee_count ?? null,
          },
          reservation: {
            id: booking.id,
            space_id: booking.space_id,
            start_at: booking.start_at,
            end_at: booking.end_at,
          },
          line: {
            catalog_item_id: line.catalog_item_id,
            catalog_item_category: line.catalog_item_category,
            menu_id: line.menu_id,
            quantity: line.quantity,
            quantity_per_attendee: null,
            service_window_start_at: line.service_window_start_at,
            service_window_end_at: line.service_window_end_at,
            unit_price: line.unit_price,
            lead_time_remaining_hours: line.lead_time_remaining_hours,
            menu: {
              fulfillment_vendor_id: line.fulfillment_vendor_id,
              fulfillment_team_id: line.fulfillment_team_id,
            },
          },
          order: {
            total_per_occurrence: orderTotal,
            total: orderTotal,
            line_count: lines.length,
          },
          permissions,
        });
      },
    });

    // ── 8. Compute aggregate flags + assemble approvals ───────────────────
    const allowOutcome = this.allowOutcome();
    const perLineApproval = planOlis.map((oli) => {
      const outcome = outcomes.get(oli.id) ?? allowOutcome;
      return {
        line_key: oli.id,
        outcome,
        scope: {
          reservation_ids: [args.booking_id],
          order_ids: [oli.order_id],
          order_line_item_ids: [oli.id],
          ticket_ids: [] as string[],
          asset_reservation_ids: oli.linked_asset_reservation_id
            ? [oli.linked_asset_reservation_id]
            : [],
        },
      };
    });

    const anyDeny = perLineApproval.some((p) => p.outcome.effect === 'deny');
    const denyMessages = anyDeny
      ? perLineApproval.flatMap((p) => p.outcome.denial_messages)
      : [];
    const anyPendingApproval = perLineApproval.some(
      (p) => p.outcome.effect === 'require_approval' || p.outcome.effect === 'allow_override',
    );

    // Patch order initial_status now that we know the aggregate.
    const orderStatus: 'submitted' | 'approved' = anyPendingApproval ? 'submitted' : 'approved';
    for (const order of planOrders) {
      order.initial_status = orderStatus;
    }

    const planApprovals = anyDeny
      ? []
      : await this.approvalRouter.assemblePlan({
          target_entity_type: 'booking',
          target_entity_id: args.booking_id,
          per_line_outcomes: perLineApproval,
          bundle_context: {
            cost_center_id: args.bundle?.cost_center_id ?? null,
            requester_person_id: args.requester_person_id,
            bundle_id: args.booking_id,
          },
          idempotencyKey: args.idempotency_key,
        });

    // ── 9. setup_emit hints + pending_setup_trigger_args (per OLI) ─────────
    // Per spec §7.6 step 12: setup_emit is ONLY populated for lines with
    // `requires_internal_setup=true` AND `any_pending_approval=false`.
    // Pending lines instead carry `pending_setup_trigger_args`, which the
    // approval-grant RPC reads at decision time to re-emit the snapshot.
    for (const oli of planOlis) {
      const outcome = outcomes.get(oli.id);
      if (!outcome || !outcome.requires_internal_setup) continue;
      const line = lineByOliId.get(oli.id)!;
      if (anyPendingApproval) {
        // Snapshot for the approval-grant RPC. Preserves the exact shape
        // `SetupWorkOrderTriggerService.triggerMany` consumed pre-v6, so
        // either the v6 strict path or the v7 outbox path can re-emit
        // without re-resolving rules.
        oli.pending_setup_trigger_args = {
          tenantId: args.tenant_id,
          bundleId: args.booking_id,
          oliId: oli.id,
          serviceCategory: line.service_type,
          serviceWindowStartAt: line.service_window_start_at,
          locationId: booking.space_id,
          ruleIds: outcome.matched_rule_ids,
          leadTimeOverride: outcome.internal_setup_lead_time_minutes,
          originSurface: 'bundle' as const,
        };
      } else {
        const setupEmit: AttachPlanSetupEmit = {
          service_category: line.service_type,
          rule_ids: outcome.matched_rule_ids,
          lead_time_override_minutes: outcome.internal_setup_lead_time_minutes,
        };
        oli.setup_emit = setupEmit;
      }
    }

    // ── 10. Bundle audit payload (mirrors bundle.service.ts:464-472) ──────
    const bundleAuditPayload: BundleAuditPayload = {
      bundle_id: args.booking_id,
      booking_id: args.booking_id,
      order_ids: planOrders.map((o) => o.id),
      order_line_item_ids: planOlis.map((o) => o.id),
      asset_reservation_ids: planAssetReservations.map((a) => a.id),
      approval_ids: planApprovals.map((a) => a.id),
      any_pending_approval: anyPendingApproval,
    };

    return {
      version: 1,
      any_pending_approval: anyPendingApproval,
      any_deny: anyDeny,
      deny_messages: denyMessages,
      orders: planOrders,
      asset_reservations: planAssetReservations,
      order_line_items: planOlis,
      approvals: planApprovals,
      bundle_audit_payload: bundleAuditPayload,
    };
  }

  /**
   * Tenant-scoped existence check on an asset id. Mirrors the head of
   * `createAssetReservation` but without writing — used by `buildAttachPlan`
   * so a cross-tenant asset id surfaces as a clean 404 instead of a P0001
   * from `validate_attach_plan_tenant_fks` deep inside the combined RPC.
   */
  private async assertAssetInTenant(assetId: string, tenantId: string): Promise<void> {
    const { data, error } = await this.supabase.admin
      .from('assets')
      .select('id')
      .eq('id', assetId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw AppErrors.notFound('asset', assetId);
    }
  }

  /**
   * `addLinesToBundle` — append new service lines to an existing booking.
   *
   * Post-canonicalisation: the bundle IS the booking (00277:27). The legacy
   * `primary_reservation_id` indirection is gone — we delegate straight to
   * `attachServicesToBooking` with the same id. Method name kept so the
   * existing `POST /booking-bundles/:id/lines` endpoint stays callable; the
   * bookings-controller-rewrite slice will rename to `addLinesToBooking` and
   * point the route at `POST /bookings/:id/lines`.
   */
  async addLinesToBundle(args: {
    bundle_id: string;
    requester_person_id: string;
    services: ServiceLineInput[];
  }): Promise<AttachServicesResult> {
    if (args.services.length === 0) {
      throw AppErrors.validationFailed('bundle.no_services', { detail: 'no service lines provided' });
    }
    const tenantId = TenantContext.current().id;

    // Verify the booking exists in this tenant before delegating. Returns
    // a clean 404 instead of letting `loadBooking` throw the same shape
    // (which would also work — this is just earlier signalling).
    const { data, error } = await this.supabase.admin
      .from('bookings')
      .select('id')
      .eq('id', args.bundle_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw AppErrors.notFound('bundle', args.bundle_id);
    }

    return this.attachServicesToBooking({
      booking_id: args.bundle_id,
      requester_person_id: args.requester_person_id,
      services: args.services,
    });
  }

  /**
   * `editLine` — patch quantity / service window / notes on an existing
   * order_line_items row. Recomputes line_total when qty changes; cascades
   * the new window to the linked work-order ticket so dispatch and SLA
   * still reflect the latest commitment.
   *
   * Visibility/write check is enforced upstream by the controller via
   * `BundleVisibilityService` + a participant/admin gate on writes.
   */
  async editLine(args: {
    line_id: string;
    patch: {
      quantity?: number;
      service_window_start_at?: string | null;
      service_window_end_at?: string | null;
      requester_notes?: string | null;
    };
    /**
     * Optimistic-concurrency token. When provided, the UPDATE only succeeds
     * if the row's `updated_at` matches — protecting against stale browser
     * edits that would otherwise overwrite a concurrent change.
     *
     * THREAT MODEL: callers that omit this accept last-write-wins semantics.
     * In practice every browser-driven edit MUST send it (the
     * bundle-services-section line editor threads `line.updated_at` through
     * automatically). The optionality exists for non-interactive callers
     * (admin scripts, server-to-server jobs) that have already taken a
     * fresher read before deciding to write. The reviewer-rule: any new
     * caller that touches `requester_notes`, `quantity`, or
     * `service_window_*` from a UI surface must include this token, or
     * the review is wrong. There's no DB-level enforcement — this is a
     * code-review contract, not a constraint.
     */
    expected_updated_at?: string | null;
  }): Promise<{ line_id: string; quantity: number; line_total: number | null; service_window_start_at: string | null; service_window_end_at: string | null; requester_notes: string | null; updated_at: string }> {
    const tenantId = TenantContext.current().id;

    // Shape-validate the patch BEFORE any DB hit. The PATCH endpoint
    // accepts a JSON body without class-validator (project convention —
    // see room-booking-rules/dto/index.ts comment). Without this, a
    // client could send `expected_updated_at: 12345` and Postgres would
    // try to cast a number to timestamp at write time, surfacing as a
    // 500 instead of a clean 400. Same risk for `requester_notes:
    // {evil:1}` reaching .trim() further down. Validate explicitly.
    if (args.patch.quantity !== undefined && (typeof args.patch.quantity !== 'number' || !Number.isFinite(args.patch.quantity))) {
      throw AppErrors.validationFailed('bundle.invalid_quantity', { detail: 'quantity must be a finite number.' });
    }
    if (
      args.patch.service_window_start_at !== undefined &&
      args.patch.service_window_start_at !== null &&
      (typeof args.patch.service_window_start_at !== 'string' || Number.isNaN(Date.parse(args.patch.service_window_start_at)))
    ) {
      throw AppErrors.validationFailed('bundle.invalid_service_window', { detail: 'service_window_start_at must be an ISO string or null.' });
    }
    if (
      args.patch.service_window_end_at !== undefined &&
      args.patch.service_window_end_at !== null &&
      (typeof args.patch.service_window_end_at !== 'string' || Number.isNaN(Date.parse(args.patch.service_window_end_at)))
    ) {
      throw AppErrors.validationFailed('bundle.invalid_service_window', { detail: 'service_window_end_at must be an ISO string or null.' });
    }
    if (
      args.patch.requester_notes !== undefined &&
      args.patch.requester_notes !== null &&
      (typeof args.patch.requester_notes !== 'string' || args.patch.requester_notes.length > 2000)
    ) {
      throw AppErrors.validationFailed('bundle.invalid_requester_notes', { detail: 'requester_notes must be a string ≤ 2000 chars or null.' });
    }
    if (
      args.expected_updated_at !== undefined &&
      args.expected_updated_at !== null &&
      (typeof args.expected_updated_at !== 'string' || Number.isNaN(Date.parse(args.expected_updated_at)))
    ) {
      throw AppErrors.validationFailed('bundle.invalid_expected_updated_at', { detail: 'expected_updated_at must be an ISO string or null.' });
    }

    const { data: existing, error: loadErr } = await this.supabase.admin
      .from('order_line_items')
      .select('id, tenant_id, order_id, quantity, unit_price, line_total, service_window_start_at, service_window_end_at, requester_notes, updated_at, fulfillment_status, linked_ticket_id')
      .eq('id', args.line_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (loadErr) throw loadErr;
    if (!existing) {
      throw AppErrors.notFoundWithCode('line_not_found', `Line ${args.line_id} not found.`);
    }
    const line = existing as {
      id: string;
      tenant_id: string;
      order_id: string;
      quantity: number;
      unit_price: number | null;
      line_total: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      requester_notes: string | null;
      updated_at: string;
      fulfillment_status: string;
      linked_ticket_id: string | null;
    };

    if (args.expected_updated_at && args.expected_updated_at !== line.updated_at) {
      throw AppErrors.conflict('line_state_changed', {
        detail: 'This line was updated by someone else while you were editing. Reload to see the latest state.',
      });
    }

    const FROZEN: Set<string> = new Set(['preparing', 'delivered', 'cancelled']);
    if (FROZEN.has(line.fulfillment_status)) {
      throw AppErrors.conflict('line_frozen', {
        detail: `Cannot edit a line in '${line.fulfillment_status}' state. Cancel and re-add instead.`,
      });
    }

    const update: Record<string, unknown> = {};
    if (typeof args.patch.quantity === 'number' && args.patch.quantity !== line.quantity) {
      if (args.patch.quantity < 1) {
        throw AppErrors.validationFailed('bundle.invalid_quantity', { detail: 'Quantity must be ≥ 1.' });
      }
      update.quantity = args.patch.quantity;
      if (line.unit_price != null) {
        update.line_total = Number((Number(line.unit_price) * args.patch.quantity).toFixed(2));
      }
    }
    if (args.patch.service_window_start_at !== undefined && args.patch.service_window_start_at !== line.service_window_start_at) {
      update.service_window_start_at = args.patch.service_window_start_at;
    }
    if (args.patch.service_window_end_at !== undefined && args.patch.service_window_end_at !== line.service_window_end_at) {
      update.service_window_end_at = args.patch.service_window_end_at;
    }
    if (args.patch.requester_notes !== undefined) {
      // Empty string normalizes to null so display logic stays binary.
      const next = args.patch.requester_notes === null ? null : args.patch.requester_notes.trim() || null;
      if (next !== line.requester_notes) {
        update.requester_notes = next;
      }
    }

    if (Object.keys(update).length === 0) {
      // No-op; return current state.
      return {
        line_id: line.id,
        quantity: line.quantity,
        line_total: line.line_total,
        service_window_start_at: line.service_window_start_at,
        service_window_end_at: line.service_window_end_at,
        requester_notes: line.requester_notes,
        updated_at: line.updated_at,
      };
    }

    // Optimistic concurrency: refuse to write if another caller has advanced
    // the line into a frozen state between our SELECT and UPDATE. The
    // `.eq('fulfillment_status', line.fulfillment_status)` clause turns a
    // would-be silent override into a 0-row result we surface as 409.
    // CAS: refuse if the line moved into a frozen state OR (when the caller
    // provided expected_updated_at) if updated_at no longer matches. The
    // second clause closes the race between our SELECT above and this
    // UPDATE for stale-browser writes.
    let updateQuery = this.supabase.admin
      .from('order_line_items')
      .update(update)
      .eq('id', line.id)
      .eq('tenant_id', tenantId)
      .eq('fulfillment_status', line.fulfillment_status);
    if (args.expected_updated_at) {
      updateQuery = updateQuery.eq('updated_at', args.expected_updated_at);
    }
    const { data: updated, error: updateErr } = await updateQuery
      .select('id, quantity, line_total, service_window_start_at, service_window_end_at, requester_notes, updated_at')
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      throw AppErrors.conflict('line_state_changed', {
        detail: 'This line was updated by someone else while you were editing. Reload to see the latest state.',
      });
    }
    const u = updated as { id: string; quantity: number; line_total: number | null; service_window_start_at: string | null; service_window_end_at: string | null; requester_notes: string | null; updated_at: string };

    // Wave 2 Slice 2: when a service window moves, shift any linked
    // booking-origin work order's sla_resolution_due_at by the same delta.
    // Preserves the lead-time relationship that was committed at create
    // time (incl. per-rule overrides) without re-running the matrix —
    // re-running could change the team or lead time mid-flight if the
    // matrix has been edited since.
    //
    // Only fires when start_at actually moved; quantity-only edits don't
    // affect timing. Idempotent if the linked WO is already terminal —
    // the whitelist filter excludes closed/resolved rows.
    const oldStart = line.service_window_start_at;
    const newStart = u.service_window_start_at;
    if (oldStart && newStart && oldStart !== newStart) {
      const deltaMs = new Date(newStart).getTime() - new Date(oldStart).getTime();
      if (deltaMs !== 0) {
        // Match cancel-cascade whitelist (bundle-cascade.service.ts) — see
        // the comment there for the schema-history reasoning.
        const NON_TERMINAL = ['new', 'assigned', 'in_progress', 'waiting', 'pending_approval'];
        // Step 1c.4 cutover: read+write work_orders directly.
        const { data: linkedWos } = await this.supabase.admin
          .from('work_orders')
          .select('id, sla_resolution_due_at')
          .eq('linked_order_line_item_id', line.id)
          .eq('tenant_id', tenantId)
          .in('status_category', NON_TERMINAL);
        for (const wo of (linkedWos ?? []) as Array<{ id: string; sla_resolution_due_at: string | null }>) {
          if (!wo.sla_resolution_due_at) continue;
          const shifted = new Date(
            new Date(wo.sla_resolution_due_at).getTime() + deltaMs,
          ).toISOString();
          await this.supabase.admin
            .from('work_orders')
            .update({ sla_resolution_due_at: shifted })
            .eq('id', wo.id)
            .eq('tenant_id', tenantId);
        }
      }
    }

    void this.audit(tenantId, 'bundle_line.updated', 'order_line_item', line.id, {
      line_id: line.id,
      patch: update,
    });

    // Slice 4: emit bundle.line.moved when the service window's start time
    // shifted. v1 doesn't expose room changes through this path (the line's
    // room is on the parent reservation; ReservationService.editOne handles
    // that), so we only emit `bundle.line.moved` here.
    //
    // Visitor lines aren't order_line_items in v1 — the visitor adapter
    // skips line_kind != 'visitor', so this emit is a no-op for visitors
    // by design. We still resolve the catering/AV kind so downstream
    // subscribers (future workstreams) can filter accurately.
    //
    // Resolve bundle_id by walking line → order → bundle. Skipped (no emit)
    // if the line isn't bundle-attached.
    if (oldStart && newStart && oldStart !== newStart) {
      const bundleId = await this.bundleIdForOrder(line.order_id, tenantId);
      if (bundleId) {
        this.emitEvent({
          kind: 'bundle.line.moved',
          tenant_id: tenantId,
          bundle_id: bundleId,
          line_id: line.id,
          line_kind: await this.lineKindForOli(line.id, tenantId),
          old_expected_at: oldStart,
          new_expected_at: newStart,
          occurred_at: new Date().toISOString(),
        });
      }
    }

    return {
      line_id: u.id,
      quantity: u.quantity,
      line_total: u.line_total,
      service_window_start_at: u.service_window_start_at,
      service_window_end_at: u.service_window_end_at,
      requester_notes: u.requester_notes,
      updated_at: u.updated_at,
    };
  }

  /**
   * `getBookingDetail` — read a booking's services + cascaded work-orders for
   * the booking-detail surface. Replaces the `GET /booking-bundles/:id`
   * endpoint (deleted with the bundles controller in this rewrite slice);
   * the booking IS the bundle now (00277:27), so the input is a booking id.
   *
   * Visibility: caller's responsibility — controllers must `assertVisible`
   * BEFORE calling. This method assumes the read is already authorized
   * because the matching reservation/booking detail endpoints already gate
   * via their own visibility services and we don't want to double-check
   * (the column shape on `bookings` is the same the visibility check
   * consumes — `requester_person_id` / `host_person_id` / `location_id`).
   *
   * Status rollup:
   *   pre-rewrite this came from the `booking_bundle_status_v` view (dropped
   *   in 00276:40). The simple line-status rollup is reproduced inline here:
   *     all-cancelled               → 'cancelled'
   *     mixed cancelled + active    → 'partially_cancelled'
   *     any pending approval        → 'pending_approval'   (reads booking.status)
   *     all delivered               → 'completed'
   *     otherwise                   → 'confirmed'
   *   Empty bundles (no lines yet) bubble up the booking's own `status`
   *   ('pending_approval' / 'confirmed' / 'cancelled') so the UI's status
   *   pill still reads truthfully on a booking with no services.
   */
  async getBookingDetail(bookingId: string): Promise<BookingDetail> {
    const tenantId = TenantContext.current().id;

    // 1. The booking row itself (also confirms tenant-scope existence).
    const { data: bookingRow, error: bookingErr } = await this.supabase.admin
      .from('bookings')
      .select(
        // 00277:27 — every column the legacy `BookingBundle` shape echoed
        // back to the frontend. `location_id` (00277:41) replaces the legacy
        // bundle.location_id; identical semantics.
        'id, tenant_id, requester_person_id, host_person_id, location_id, ' +
          'start_at, end_at, timezone, source, status, ' +
          'cost_center_id, template_id, calendar_event_id, policy_snapshot, ' +
          'created_at, updated_at',
      )
      .eq('id', bookingId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (bookingErr) throw bookingErr;
    if (!bookingRow) {
      throw AppErrors.notFound('booking', bookingId);
    }
    const booking = bookingRow as unknown as {
      id: string;
      tenant_id: string;
      requester_person_id: string;
      host_person_id: string | null;
      location_id: string;
      start_at: string;
      end_at: string;
      timezone: string | null;
      source: string;
      status: string;
      cost_center_id: string | null;
      template_id: string | null;
      calendar_event_id: string | null;
      policy_snapshot: Record<string, unknown>;
      created_at: string;
      updated_at: string;
    };

    // 2. Orders + work_orders in parallel. Both use the renamed
    //    `booking_id` FK (00278:109 for orders, 00278:87 for work_orders).
    //    Work-order joins denormalize the assignee label so the frontend
    //    doesn't need a second round-trip per ticket.
    const [ordersRes, workOrdersRes] = await Promise.all([
      this.supabase.admin
        .from('orders')
        .select('id, status, requested_for_start_at, requested_for_end_at')
        .eq('booking_id', bookingId)
        .eq('tenant_id', tenantId),
      this.supabase.admin
        .from('work_orders')
        .select(
          // module_number from 00213:118 (alloced via tickets_assign_module_number trigger);
          // assignee fields per 00213:71-74; status_category 00213:53.
          'id, status_category, assigned_user_id, assigned_team_id, assigned_vendor_id, module_number, ' +
            'assigned_user:users!assigned_user_id(person:persons!person_id(first_name,last_name)), ' +
            'assigned_team:teams!assigned_team_id(name), ' +
            'assigned_vendor:vendors!assigned_vendor_id(name)',
        )
        .eq('booking_id', bookingId)
        .eq('tenant_id', tenantId),
    ]);
    if (ordersRes.error) throw ordersRes.error;
    if (workOrdersRes.error) throw workOrdersRes.error;

    const orders = (ordersRes.data ?? []) as Array<{
      id: string;
      status: string;
      requested_for_start_at: string | null;
      requested_for_end_at: string | null;
    }>;
    const orderIds = orders.map((o) => o.id);

    // 3. Lines (a second round-trip; unavoidable without a SQL function
    //    because PostgREST doesn't let us join order_line_items via the
    //    booking → orders → lines path in one query without losing the
    //    catalog_item name embed).
    type LineRow = {
      id: string;
      order_id: string;
      catalog_item_id: string;
      quantity: number;
      unit_price: number | null;
      line_total: number | null;
      service_window_start_at: string | null;
      service_window_end_at: string | null;
      requester_notes: string | null;
      updated_at: string;
      // 00013:82 — fulfillment_status enum (ordered/confirmed/preparing/delivered/cancelled).
      fulfillment_status: 'ordered' | 'confirmed' | 'preparing' | 'delivered' | 'cancelled' | null;
      linked_ticket_id: string | null;
      linked_asset_reservation_id: string | null;
      catalog_item: { name: string } | { name: string }[] | null;
    };
    let lines: BundleLineDetail[] = [];
    if (orderIds.length > 0) {
      const linesRes = await this.supabase.admin
        .from('order_line_items')
        .select(
          'id, order_id, catalog_item_id, quantity, unit_price, line_total, ' +
            'service_window_start_at, service_window_end_at, requester_notes, ' +
            'updated_at, fulfillment_status, linked_ticket_id, linked_asset_reservation_id, ' +
            'catalog_item:catalog_items(name)',
        )
        .in('order_id', orderIds)
        .eq('tenant_id', tenantId);
      if (linesRes.error) throw linesRes.error;
      lines = ((linesRes.data ?? []) as unknown as LineRow[]).map((row) => {
        const ci = Array.isArray(row.catalog_item) ? row.catalog_item[0] : row.catalog_item;
        return {
          id: row.id,
          order_id: row.order_id,
          catalog_item_id: row.catalog_item_id,
          catalog_item_name: ci?.name ?? null,
          quantity: row.quantity,
          unit_price: row.unit_price,
          line_total: row.line_total,
          service_window_start_at: row.service_window_start_at,
          service_window_end_at: row.service_window_end_at,
          requester_notes: row.requester_notes,
          updated_at: row.updated_at,
          fulfillment_status: row.fulfillment_status,
          linked_ticket_id: row.linked_ticket_id,
          linked_asset_reservation_id: row.linked_asset_reservation_id,
        };
      });
    }

    // 4. Denormalized assignee label per work_order. Mirrors the legacy
    //    controller's join handling so the frontend BundleTicketRef shape
    //    is unchanged. `ticket_kind` is synthesized as 'work_order' — the
    //    column was dropped in step 1c.10c (every row in `work_orders` is
    //    a work order by table-membership), but the frontend still
    //    branches on it.
    type WorkOrderRow = {
      id: string;
      status_category: string | null;
      assigned_user_id: string | null;
      assigned_team_id: string | null;
      assigned_vendor_id: string | null;
      module_number: number | null;
      assigned_user?:
        | { person?: { first_name: string | null; last_name: string | null } | null }
        | null;
      assigned_team?: { name: string | null } | null;
      assigned_vendor?: { name: string | null } | null;
    };
    const tickets: BundleTicketDetail[] = (
      (workOrdersRes.data ?? []) as unknown as WorkOrderRow[]
    ).map((wo) => {
      const userPerson = wo.assigned_user?.person ?? null;
      const userName = userPerson
        ? `${userPerson.first_name ?? ''} ${userPerson.last_name ?? ''}`.trim()
        : null;
      const assignee_label = wo.assigned_vendor_id
        ? wo.assigned_vendor?.name ?? 'Vendor'
        : wo.assigned_team_id
          ? wo.assigned_team?.name ?? 'Team'
          : wo.assigned_user_id
            ? userName || 'User'
            : null;
      return {
        id: wo.id,
        ticket_kind: 'work_order' as const,
        status_category: wo.status_category,
        assigned_user_id: wo.assigned_user_id,
        assigned_team_id: wo.assigned_team_id,
        assigned_vendor_id: wo.assigned_vendor_id,
        module_number: wo.module_number,
        assignee_label,
      };
    });

    return {
      ...booking,
      status_rollup: this.computeStatusRollup(booking.status, lines),
      orders,
      tickets,
      lines,
    };
  }

  /**
   * Reproduces the rollup the dropped `booking_bundle_status_v` view used to
   * compute. Called by `getBookingDetail`; not exposed.
   *
   *   - Empty bundle → bubble booking.status (so a 'pending_approval' booking
   *     with no lines still surfaces as 'pending_approval', not 'confirmed').
   *   - Any line in 'cancelled' AND every other line in 'cancelled' → 'cancelled'.
   *   - Mix of cancelled + non-cancelled → 'partially_cancelled'.
   *   - Booking itself pending approval → 'pending_approval' wins.
   *   - All non-cancelled lines delivered → 'completed'.
   *   - Otherwise → 'confirmed'.
   */
  private computeStatusRollup(
    bookingStatus: string,
    lines: BundleLineDetail[],
  ): BundleStatusRollup {
    if (bookingStatus === 'cancelled') return 'cancelled';
    if (bookingStatus === 'pending_approval') return 'pending_approval';
    if (lines.length === 0) {
      // Map the booking's own status to a rollup label the frontend
      // recognises. 'completed' / 'confirmed' / 'cancelled' / 'pending_approval'
      // all already map 1:1; 'draft'/'checked_in'/'released' fall back to
      // 'pending' (the only safe neutral the frontend renders).
      if (bookingStatus === 'completed') return 'completed';
      if (bookingStatus === 'confirmed') return 'confirmed';
      return 'pending';
    }
    const cancelled = lines.filter((l) => l.fulfillment_status === 'cancelled');
    const active = lines.filter((l) => l.fulfillment_status !== 'cancelled');
    if (cancelled.length === lines.length) return 'cancelled';
    if (cancelled.length > 0 && active.length > 0) return 'partially_cancelled';
    if (active.every((l) => l.fulfillment_status === 'delivered')) return 'completed';
    return 'confirmed';
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Load the booking row that services will attach to. Reads from `bookings`
   * (00277:27); the legacy `loadReservation` against `reservations` was
   * dropped with the table.
   *
   * The local `BookingRow` shape preserves the field names the rest of this
   * service uses, with `space_id` mapped from `bookings.location_id`
   * (00277:41). Bundle-level booking has no per-slot `space_id` — the
   * location anchor IS the space for the v1 single-slot path. Multi-slot
   * bookings (when MultiRoomBookingService rewrites) will need to pick a
   * primary slot's space_id; v1 keeps the single-slot mapping.
   */
  private async loadBooking(id: string): Promise<BookingRow> {
    const tenantId = TenantContext.current().id;
    const { data, error } = await this.supabase.admin
      .from('bookings')
      .select('id, tenant_id, location_id, requester_person_id, host_person_id, start_at, end_at, source')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw AppErrors.notFound('booking', id);
    }
    const row = data as {
      id: string;
      tenant_id: string;
      location_id: string;
      requester_person_id: string;
      host_person_id: string | null;
      start_at: string;
      end_at: string;
      source: string | null;
    };

    // Pull attendee_count from the booking's primary slot (lowest
    // display_order, 00277:154). Multi-slot bookings would want per-slot
    // counts; the v1 single-slot path collapses to one row.
    const { data: slot } = await this.supabase.admin
      .from('booking_slots')
      .select('attendee_count')
      .eq('booking_id', id)
      .eq('tenant_id', tenantId)
      .order('display_order', { ascending: true })
      .limit(1)
      .maybeSingle();

    return {
      id: row.id,
      tenant_id: row.tenant_id,
      space_id: row.location_id,
      requester_person_id: row.requester_person_id,
      host_person_id: row.host_person_id,
      start_at: row.start_at,
      end_at: row.end_at,
      attendee_count: (slot as { attendee_count: number | null } | null)?.attendee_count ?? null,
      booking_bundle_id: row.id,                  // booking IS the bundle now
      source: row.source,
    };
  }

  private async hydrateLines(inputs: ServiceLineInput[], booking: BookingRow): Promise<HydratedLine[]> {
    const out: HydratedLine[] = [];
    const now = Date.now();
    const tenantId = booking.tenant_id;
    for (const input of inputs) {
      // Look up the catalog item — gives us category + price/unit defaults
      // that the resolver doesn't otherwise see. Tenant-filter to refuse
      // cross-tenant catalog ids passed in the payload.
      const { data: item, error: itemErr } = await this.supabase.admin
        .from('catalog_items')
        .select('id, category, price_per_unit, unit, fulfillment_team_id')
        .eq('id', input.catalog_item_id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (itemErr) throw itemErr;
      if (!item) throw AppErrors.notFound('catalog_item', input.catalog_item_id);

      // Resolve menu offer to get vendor/team + price snapshot.
      let menuId = input.menu_id ?? null;
      let menuPrice: number | null = null;
      let menuUnit: 'per_item' | 'per_person' | 'flat_rate' | null = null;
      let serviceType = 'other';
      let fulfillmentVendorId: string | null = null;
      let fulfillmentTeamId: string | null = (item as { fulfillment_team_id: string | null }).fulfillment_team_id ?? null;

      const { data: offer, error: offerErr } = await this.supabase.admin.rpc('resolve_menu_offer', {
        p_catalog_item_id: input.catalog_item_id,
        p_delivery_space_id: booking.space_id,
        p_on_date: booking.start_at.slice(0, 10),
      });
      if (offerErr) throw offerErr;
      const offerRow = ((offer ?? []) as Array<{
        menu_id: string;
        menu_item_id: string;
        vendor_id: string | null;
        fulfillment_team_id: string | null;
        price: number | null;
        unit: 'per_item' | 'per_person' | 'flat_rate' | null;
        lead_time_hours: number | null;
        service_type: string;
      }>)[0];

      if (offerRow) {
        menuId = offerRow.menu_id;
        menuPrice = offerRow.price;
        menuUnit = offerRow.unit;
        serviceType = offerRow.service_type;
        fulfillmentVendorId = offerRow.vendor_id;
        fulfillmentTeamId = offerRow.fulfillment_team_id ?? fulfillmentTeamId;
      } else {
        // No menu offer found; fall back to catalog item's defaults.
        menuPrice = (item as { price_per_unit: number | null }).price_per_unit ?? null;
        menuUnit = (item as { unit: 'per_item' | 'per_person' | 'flat_rate' }).unit ?? 'per_item';
      }

      const startAt = input.service_window_start_at ?? booking.start_at;
      const endAt = input.service_window_end_at ?? booking.end_at;
      const leadRemaining = (Date.parse(startAt) - now) / 3_600_000; // hours

      // Server-side lead-time guard. The picker (service-picker-sheet)
      // already disables items whose `lead_time_hours` exceeds remaining
      // time, but that's a UX layer — any non-portal write path (admin
      // tools, future bulk-edit, server-to-server) bypasses it. This
      // hard gate catches those. Only fires when the menu offer carries
      // an explicit lead_time_hours; offer-less items (catalog default
      // pricing) skip the check the same way they did before.
      if (
        offerRow?.lead_time_hours != null &&
        offerRow.lead_time_hours > leadRemaining
      ) {
        throw AppErrors.validationFailed('bundle.lead_time_violation', {
          detail: `Service requires ${offerRow.lead_time_hours}h advance notice; only ${leadRemaining.toFixed(1)}h remain. Move the meeting later or remove this service.`,
        });
      }

      out.push({
        id: '', // assigned by Supabase on insert
        catalog_item_id: input.catalog_item_id,
        catalog_item_category: (item as { category: string | null }).category,
        menu_id: menuId,
        menu_item_id: offerRow?.menu_item_id ?? null,
        quantity: input.quantity,
        unit_price: menuPrice,
        unit: menuUnit,
        service_window_start_at: startAt,
        service_window_end_at: endAt,
        repeats_with_series: input.repeats_with_series ?? true,
        linked_asset_id: input.linked_asset_id ?? null,
        service_type: serviceType,
        fulfillment_vendor_id: fulfillmentVendorId,
        fulfillment_team_id: fulfillmentTeamId,
        lead_time_remaining_hours: leadRemaining,
      });
    }
    return out;
  }

  // lazyCreateBundle removed: post-canonicalisation the booking IS the
  // bundle (00277:27). Bookings are created upstream by
  // BookingFlowService.create via the create_booking RPC; service attach
  // never needs to materialise a bundle row of its own.


  private allowOutcome() {
    return {
      effect: 'allow' as const,
      matched_rule_ids: [],
      denial_messages: [],
      warning_messages: [],
      approver_targets: [],
      requires_internal_setup: false,
      internal_setup_lead_time_minutes: null,
    };
  }


  /**
   * Approval-decided handler. Called by ApprovalService.respondToApproval
   * once a `target_entity_type='booking_bundle'` approval row has resolved
   * (single-step decision OR final-step / parallel-group completion). Both
   * the bundle and standalone-order paths use `'booking_bundle'` as the
   * target type, so this handles them uniformly.
   *
   * On approve:
   *   - Flip every linked order from 'submitted' → 'approved' (idempotent —
   *     orders that already moved on don't get re-stamped).
   *   - Re-fire the deferred setup-work-order trigger for any OLI whose
   *     `pending_setup_trigger_args` was persisted at create time. The args
   *     are a snapshot from creation, so we don't re-resolve rules here.
   *   - Clear `pending_setup_trigger_args` once fired (one-shot).
   *   - Audit `bundle.deferred_setup_fired_on_approval` with the OLI list.
   *
   * On reject:
   *   - Flip linked orders 'submitted' → 'cancelled'.
   *   - Clear `pending_setup_trigger_args` (no longer relevant — line is dead).
   *   - Audit `bundle.deferred_setup_dropped_on_rejection`.
   *
   * Idempotency: safe to call multiple times. Order status updates filter on
   * `status='submitted'`, OLI updates filter on the persisted args being
   * present. A second invocation is a no-op.
   *
   * Failure posture: never throws. Approval-side audit + state already
   * landed before this is called; partial failures here are logged + audited
   * separately so admins can re-fire manually if needed. Same posture as
   * the create-time trigger.
   */
  async onApprovalDecided(
    bundleId: string,
    decision: 'approved' | 'rejected',
    /**
     * Optional actor user id — recorded on the audit_events row the new
     * `approve_booking_setup_trigger` RPC writes inside its tx. Defaults
     * to null when the caller doesn't have one (admin batch tooling).
     */
    actorUserId: string | null = null,
    /**
     * Optional client-supplied idempotency key. Defaults to a stable
     * key derived from the booking id so repeated invocations of the
     * RPC for the same booking + actor share an audit trail.
     */
    idempotencyKey?: string,
  ): Promise<void> {
    const tenantId = TenantContext.current().id;

    // ─── B.0.D.4 cutover ──────────────────────────────────────────────
    //
    // The pre-cutover body was a five-step TS pipeline (load orders,
    // flip orders.status, expire sibling approvals on rejection,
    // claim_deferred_setup_trigger_args RPC, setupTrigger.triggerMany)
    // that the v6 spec called out as a non-atomic split-write: the
    // claim RPC committed first (NULLing pending_setup_trigger_args)
    // and the trigger HTTP call ran in a separate tx, so a crash
    // between them lost the deferred setup work. v7+ collapses ALL of
    // it into the new approve_booking_setup_trigger RPC (00311), which
    // reads + emits + clears in ONE Postgres transaction, taking a
    // (tenant_id, booking_id) advisory lock for per-grant
    // serialisation.
    //
    // After B.0.D.3, this method has no production callers — the
    // approval grant goes through grant_booking_approval RPC which
    // calls approve_booking_setup_trigger inline via PERFORM. The
    // method stays callable for admin batch tooling and any future
    // path that wants to drive the setup-WO emit directly without
    // going through the full booking-approval state machine.
    //
    // Return-shape change: the legacy method returned void after
    // logging audits. The new RPC returns
    // { emitted_count, skipped_cancelled, skipped_no_args } which we
    // log but don't propagate — the void-return contract stays so
    // existing call sites compile unchanged.

    if (decision === 'rejected') {
      // Rejection: clear the persisted args without emitting. The
      // grant_booking_approval RPC handles this in its own tx for
      // booking-target rejections; this branch covers admin tooling
      // that wants to call BundleService.onApprovalDecided directly
      // for a non-grant rejection (e.g. force-cancel a bundle that
      // never made it to a real approval row).
      try {
        const { error: clearErr } = await this.supabase.admin
          .from('order_line_items')
          .update({ pending_setup_trigger_args: null })
          .eq('tenant_id', tenantId)
          .not('pending_setup_trigger_args', 'is', null)
          .in(
            'order_id',
            (
              await this.supabase.admin
                .from('orders')
                .select('id')
                .eq('tenant_id', tenantId)
                .eq('booking_id', bundleId)
                .then((r) => (r.data ?? []).map((o) => (o as { id: string }).id))
            ),
          );
        if (clearErr) {
          this.log.error(
            `onApprovalDecided rejection clear failed for bundle ${bundleId}: ${clearErr.message}`,
          );
        }
      } catch (err) {
        this.log.error(
          `onApprovalDecided rejection clear threw for bundle ${bundleId}: ${(err as Error).message}`,
        );
      }
      void this.audit(
        tenantId,
        'bundle.deferred_setup_dropped_on_rejection',
        'booking_bundle',
        bundleId,
        { bundle_id: bundleId, decision },
      );
      return;
    }

    // Approved: call approve_booking_setup_trigger which reads OLIs
    // for the booking, validates persisted ruleIds (v8-I6 defense-in-
    // depth), emits one outbox event per non-null OLI, clears the
    // args, writes an audit row — all in ONE transaction.
    const idemKey =
      idempotencyKey ?? `approval_grant_setup:${bundleId}:${actorUserId ?? 'system'}`;
    const { data, error } = await this.supabase.admin.rpc(
      'approve_booking_setup_trigger',
      {
        p_booking_id: bundleId,
        p_tenant_id: tenantId,
        p_actor_user_id: actorUserId,
        p_idempotency_key: idemKey,
      },
    );

    if (error) {
      this.log.error(
        `onApprovalDecided: approve_booking_setup_trigger failed for bundle ${bundleId}: ${error.message}`,
      );
      void this.audit(
        tenantId,
        'bundle.deferred_setup_emit_failed',
        'booking_bundle',
        bundleId,
        {
          bundle_id: bundleId,
          error_code: (error as { code?: string }).code ?? null,
          error_message: error.message,
          severity: 'high',
        },
      );
      return;
    }

    const summary = (data ?? null) as {
      emitted_count?: number;
      skipped_cancelled?: number;
      skipped_no_args?: number;
    } | null;
    this.log.log(
      `onApprovalDecided: bundle=${bundleId} emitted=${summary?.emitted_count ?? 0} ` +
        `skipped_cancelled=${summary?.skipped_cancelled ?? 0} ` +
        `skipped_no_args=${summary?.skipped_no_args ?? 0}`,
    );
  }

  private async audit(
    tenantId: string,
    eventType: string,
    entityType: string,
    entityId: string | null,
    details: Record<string, unknown>,
  ) {
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: entityType,
        entity_id: entityId,
        details,
      });
    } catch (err) {
      this.log.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }

  /**
   * Slice 4: best-effort emit. Subscribers run async; their failures are
   * isolated by the bus subscription. We still wrap the synchronous
   * `emit` in try/catch so a misbehaving sync subscriber can't bubble
   * back into editLine after the DB write already landed.
   */
  private emitEvent(event: BundleEvent): void {
    try {
      this.eventBus.emit(event);
    } catch (err) {
      this.log.warn(
        `bundle event emit failed for ${event.kind}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Resolve bundle_id (= booking_id under canonicalisation) from an order
   * id with tenant defence. Returns null when the order isn't booking-attached
   * or doesn't exist; callers skip the emit in that case.
   *
   * Column rename: orders.booking_bundle_id → orders.booking_id (00278:109).
   */
  private async bundleIdForOrder(orderId: string, tenantId: string): Promise<string | null> {
    try {
      const { data } = await this.supabase.admin
        .from('orders')
        .select('booking_id')
        .eq('id', orderId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      return ((data as { booking_id: string | null } | null)?.booking_id) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Map order_line_items.policy_snapshot.service_type to a BundleLineKind.
   * Mirrors BundleCascadeService.lineKindForOli — kept in sync there.
   * Visitors are not order_line_items in v1, so 'visitor' is never returned.
   */
  private async lineKindForOli(
    oliId: string,
    tenantId: string,
  ): Promise<'visitor' | 'room' | 'catering' | 'av' | 'other'> {
    try {
      const { data } = await this.supabase.admin
        .from('order_line_items')
        .select('policy_snapshot')
        .eq('id', oliId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const snapshot = (data as { policy_snapshot: Record<string, unknown> | null } | null)
        ?.policy_snapshot ?? null;
      const serviceType = (snapshot && typeof snapshot === 'object'
        ? (snapshot as { service_type?: string }).service_type
        : null) ?? null;
      if (serviceType === 'catering') return 'catering';
      if (serviceType === 'av' || serviceType === 'audiovisual') return 'av';
      return 'other';
    } catch {
      return 'other';
    }
  }
}

// ── Local types ───────────────────────────────────────────────────────────

/**
 * Status rollup string the frontend's BundleStatusRollup union expects.
 * Mirrors `apps/web/src/api/booking-bundles/types.ts` so wire-shape parity
 * doesn't need a separate package.
 */
export type BundleStatusRollup =
  | 'pending'
  | 'pending_approval'
  | 'confirmed'
  | 'partially_cancelled'
  | 'cancelled'
  | 'completed';

/**
 * Per-line shape returned by `getBookingDetail`. Mirrors the legacy
 * `BundleLine` projection — column list at the SELECT in `getBookingDetail`.
 */
export interface BundleLineDetail {
  id: string;
  order_id: string;
  catalog_item_id: string;
  /** Pulled from the embedded `catalog_items.name`; null if the catalog row
   *  was deleted (rare; soft-delete is the norm on the catalog side). */
  catalog_item_name: string | null;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  service_window_start_at: string | null;
  service_window_end_at: string | null;
  requester_notes: string | null;
  /** Optimistic-concurrency token for `editLine`. */
  updated_at: string;
  fulfillment_status:
    | 'ordered'
    | 'confirmed'
    | 'preparing'
    | 'delivered'
    | 'cancelled'
    | null;
  linked_ticket_id: string | null;
  linked_asset_reservation_id: string | null;
}

/**
 * Per-ticket (work-order today; cases later) shape. `ticket_kind` is
 * synthesized as 'work_order' — the underlying column was dropped at step
 * 1c.10c, but the frontend BundleTicketRef still branches on it.
 */
export interface BundleTicketDetail {
  id: string;
  ticket_kind: 'work_order';
  status_category: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  module_number: number | null;
  /** Pre-computed assignee label so the frontend doesn't need a second
   *  round-trip per ticket — vendor name | team name | user full name. */
  assignee_label: string | null;
}

/**
 * `BookingDetail` — return shape of `getBookingDetail`. Echoes the booking
 * row's columns plus the cascaded entity arrays. Stays close to the legacy
 * `GET /booking-bundles/:id` payload so the existing frontend BundleData
 * type continues to compile (only delta: the empty-bundle case used to
 * return zero lines/tickets/orders, which this method also does).
 */
export interface BookingDetail {
  id: string;
  tenant_id: string;
  requester_person_id: string;
  host_person_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string | null;
  source: string;
  status: string;
  cost_center_id: string | null;
  template_id: string | null;
  calendar_event_id: string | null;
  policy_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  status_rollup: BundleStatusRollup;
  orders: Array<{
    id: string;
    status: string;
    requested_for_start_at: string | null;
    requested_for_end_at: string | null;
  }>;
  tickets: BundleTicketDetail[];
  lines: BundleLineDetail[];
}

/**
 * In-service projection of a Booking + its primary slot, hand-built by
 * `loadBooking`. Field names preserve the legacy `space_id` / `attendee_count`
 * naming so the rest of this service reads naturally; the actual columns in
 * Postgres are `bookings.location_id` (00277:41) and
 * `booking_slots.attendee_count` (00277:138). `booking_bundle_id` is set to
 * the booking's own id (canonicalisation: booking IS the bundle).
 */
interface BookingRow {
  id: string;
  tenant_id: string;
  space_id: string;                         // mapped from bookings.location_id
  requester_person_id: string;
  host_person_id: string | null;
  start_at: string;
  end_at: string;
  attendee_count: number | null;            // pulled from primary slot
  booking_bundle_id: string | null;         // = id (legacy alias for in-service code)
  source: string | null;
}

interface HydratedLine {
  id: string;
  catalog_item_id: string;
  catalog_item_category: string | null;
  menu_id: string | null;
  menu_item_id: string | null;
  quantity: number;
  unit_price: number | null;
  unit: 'per_item' | 'per_person' | 'flat_rate' | null;
  service_window_start_at: string;
  service_window_end_at: string;
  repeats_with_series: boolean;
  linked_asset_id: string | null;
  service_type: string;
  fulfillment_vendor_id: string | null;
  fulfillment_team_id: string | null;
  lead_time_remaining_hours: number;
}


function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    'code' in err &&
    (err as { code: string }).code === '23P01'
  );
}
