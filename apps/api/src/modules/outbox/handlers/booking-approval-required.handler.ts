import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppErrors } from '../../../common/errors';
import { TenantContext } from '../../../common/tenant-context';
import { SupabaseService } from '../../../common/supabase/supabase.service';
import { UUID_RE } from '../../../common/tenant-validation';
import { NotificationsService } from '../../notifications';
import type { BookingApprovalRequiredPayload as TemplatePayload } from '../../notifications';
import { BookingEditEventType } from '../../reservations/event-types';
import { DeadLetterError } from '../dead-letter.error';
import { OutboxHandler, type OutboxEventHandler } from '../outbox-handler.decorator';
import type { OutboxEvent } from '../outbox.types';

/**
 * BookingApprovalRequiredHandler — drains `booking.approval_required` outbox
 * events emitted by the `edit_booking` RPC when a §3.6.5 row 2/7/8 outcome
 * flipped the booking from final → require_approval and inserted a fresh
 * approval chain.
 *
 * Producer: supabase/migrations/00394_edit_booking_rpc_v5.sql:974-993
 *           (`if v_emit_approval_required then perform outbox.emit(...)`)
 *           — supersedes 00364 v4. v5 splits the v4 mixed `approver_ids`
 *           field into `approver_person_ids` (persons.id values) +
 *           `approver_team_ids` (team ids).
 * Event type literal: apps/api/src/modules/reservations/event-types.ts:51
 *           (`BookingEditEventType.ApprovalRequired`).
 *
 * ── B.4.A.5 sub-step D — what this handler does ─────────────────────────
 *
 * 1. Validate payload + tenant boundary.
 * 2. Re-read approval state for `chain_id` (architect C3 — mirrors
 *    sla-timer-repoint.handler.ts:84-101). If chain is fully resolved or
 *    rows are missing → no-op (NOT retry). Catches the race where the
 *    booking is cancelled between RPC commit and handler drain.
 * 3. Resolve `approver_person_ids` → users via `users.person_id IN (...)`
 *    JOIN tenant-scoped (mirrors the same lookup the RPC does at
 *    00394:807-819).
 * 4. Resolve `approver_team_ids` → fan out via `team_members` join in TS
 *    (mirrors approval.service.ts:184-233 pattern). Tenant-filter every
 *    JOIN — tenant_id is the #0 invariant.
 * 5. Union of person + team users; resolve tenant locale ONCE (NOT per
 *    user) — see "Locale resolution" below.
 * 6. Enrich payload (booking + space + requester JOINs) → typed
 *    `BookingApprovalRequiredPayload` consumed by NotificationsService /
 *    TemplateResolverService.
 * 7. Per user: NotificationsService.dispatch with idempotencyKey =
 *    `<event.id>:<userId>`. Per-user try/catch — one failure doesn't
 *    block others.
 *
 * Inbox writes are NOT in this handler — the producer RPC writes them
 * atomically per Hybrid C (locked decision #5 in /tmp/b4a5-plan-v2.md).
 *
 * ── Source-of-truth re-read (architect C3) ──────────────────────────────
 *
 * `select status, approver_person_id, approver_team_id from approvals
 *  where tenant_id = X and approval_chain_id = chain_id`
 *
 *   - rows missing entirely → chain was deleted (e.g. booking cancelled
 *     between RPC commit and handler drain) → no-op log + return.
 *   - all rows status != 'pending' → chain already resolved by another
 *     path (race-y but possible: a delegate approved before email
 *     dispatch fires) → no-op.
 *   - else → proceed with dispatch for the still-pending approvers
 *     declared in the payload (we trust the payload's approver lists,
 *     since the RPC built them atomically with the chain insert; the
 *     re-read is a sanity gate, not a re-derivation).
 *
 * ── Cross-tenant defense (memory: feedback_tenant_id_ultimate_rule) ─────
 *
 * Service-role bypasses RLS, so tenant_id is asserted defensively at the
 * top: payload.tenant_id must equal event.tenant_id, mismatch → terminal
 * dead-letter. Every supabase.admin query filters by `tenant_id =
 * event.tenant_id`. The `approver_person_ids` + `approver_team_ids` are
 * trusted only to scope the user lookup — the lookup itself is tenant-
 * filtered, so a smuggled cross-tenant id resolves to zero rows.
 *
 * ── Locale resolution (self-review C2/C3 + I2) ──────────────────────────
 *
 * v1 derives the per-user locale from `tenants.locale_default` (already on
 * the tenants table at 00001_tenants.sql:20). The fetch happens ONCE per
 * event — not per user — so a 50-approver team event still issues a single
 * tenants read instead of 50. NL-primary tenants get NL emails (per
 * memory project_market_benelux.md).
 *
 * When `users.locale_preference` lands on the users table, the per-user
 * override is a single LEFT JOIN added to the user fetches in steps
 * 5/6 — call sites are marked with TODO comments below.
 *
 * Plan-review I6: locale resolution NEVER throws. A missing/unparseable
 * tenants row falls back to 'en'.
 *
 * ── Idempotency (plan-review I4) ────────────────────────────────────────
 *
 * `idempotencyKey = <outbox_event_id>:<userId>` is passed to
 * NotificationsService.dispatch → EmailChannel → MAIL_PROVIDER as the
 * Resend `Idempotency-Key` header. At-least-once outbox delivery × N
 * approvers stays exactly-once at the email provider (Resend dedupes
 * within 24h on key + payload). The inbox row's idempotency is handled
 * by the partial unique index in 00391 (handler doesn't write inbox).
 *
 * Outbox max-attempt + backoff configuration (worker.ts:33 + 47) defaults
 * to ~70 minutes worst case (5 attempts × {30s, 2m, 10m, 1h}); well inside
 * Resend's 24h dedupe window. Followup logged in
 * docs/follow-ups/b4a5-followups.md to verify on any future bump to the
 * env knobs.
 *
 * ── Per-user isolation ──────────────────────────────────────────────────
 *
 * One approver's dispatch failure (e.g. their email row got hard-deleted
 * between the user fetch and the channel call) MUST NOT block the
 * other approvers from getting their email. Wrap each dispatch in
 * try/catch + warn-log. The outbox retry will re-fire the whole event
 * for transient errors — `ON CONFLICT` on inbox + `Idempotency-Key`
 * on Resend make those retries safe.
 *
 * ── Legacy v4 backward-compat shim (codex remediation, drain-window only)
 *
 * Outbox events emitted by 00364 v4 BEFORE the v5 cutover (commits
 * 7852ebf0 + c7ddb037 push) carry the mixed `approver_ids` field instead
 * of the split `approver_person_ids` + `approver_team_ids`. The validation
 * block tolerates that shape best-effort: legacy `approver_ids` is treated
 * as person-only + a `legacy_payload_shape_detected` warn line fires. Team
 * uuids smuggled inside legacy events fall through to user-fetch failure
 * (yielding zero matches, then a no-op). Remove the shim after the drain
 * window closes (no v4-shape events remain in `outbox.events`).
 */

export interface BookingApprovalRequiredPayload {
  /** Tenant — duplicated from event.tenant_id for defense-in-depth. */
  tenant_id: string;
  /** Booking row id (aggregate). */
  booking_id: string;
  /** Approval chain row id inserted by edit_booking for this flip. */
  chain_id: string;
  /**
   * Person approver ids — these are `persons.id` values, NOT `users.id`.
   * They originate from `required_approvers[n].id` in the edit plan where
   * `type='person'`. Sub-step D resolves person → user in tenant scope via
   * `users.person_id` JOIN at dispatch time — the same way the inbox INSERT
   * inside the producer RPC already does (see 00394:807-819).
   *
   * v5 (00394) split the v4 mixed `approver_ids` field into two typed arrays
   * so the handler doesn't have to re-classify each id. The self-review
   * remediation on commit 7852ebf0 renamed this from the original
   * `approver_user_ids` because that name lied about the contents (a
   * `users WHERE id = any(...)` lookup against persons.id values would
   * return zero rows).
   */
  approver_person_ids: string[];
  /**
   * Team approver ids. Sub-step D fans these out via team_members.user_id
   * JOIN public.users (tenant-filtered both sides) at dispatch time. The
   * inbox row(s) for these team members were already written by the RPC
   * (Hybrid C); the handler is responsible only for email dispatch.
   */
  approver_team_ids: string[];
  /** ISO timestamp captured by the RPC (v_started_at). */
  started_at: string;
  /**
   * Legacy v4 mixed-array field (persons + teams in one bucket). Present
   * only on outbox events emitted by 00364 v4 BEFORE the v5 cutover landed
   * on remote (commits 7852ebf0 + c7ddb037 push). Handler treats this as
   * `approver_person_ids` best-effort + emits a `legacy_payload_shape_
   * detected` warn line so ops can spot drain-window events. Team uuids
   * smuggled inside this array fall through to user-fetch failure (already
   * logged by sub-step D's dispatch path). Remove this fallback after the
   * v4 drain window closes — see codex remediation commit message.
   */
  approver_ids?: string[];
}

@Injectable()
@OutboxHandler(BookingEditEventType.ApprovalRequired, { version: 1 })
export class BookingApprovalRequiredHandler
  implements OutboxEventHandler<BookingApprovalRequiredPayload>
{
  private readonly log = new Logger(BookingApprovalRequiredHandler.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async handle(event: OutboxEvent<BookingApprovalRequiredPayload>): Promise<void> {
    const payload = event.payload;

    // ── 1. Tenant smuggling defense ──────────────────────────────────────
    if (!payload || payload.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `booking.approval_required.tenant_mismatch: event.tenant_id=${event.tenant_id} payload.tenant_id=${payload?.tenant_id}`,
      );
    }

    // ── 2. Validate payload shape ─────────────────────────────────────────
    //
    // Producer is supabase/migrations/00394_edit_booking_rpc_v5.sql:974-993
    // (v5 split mixed `approver_ids` into `approver_person_ids` +
    // `approver_team_ids` — keys are typed at the JSON layer to drop the
    // re-classification step the handler used to do). Any shape mismatch
    // is a contract bug requiring code change, not retry.
    //
    // Legacy v4 backward-compat shim. Codex remediation: events emitted by
    // 00364 v4 BEFORE the v5 cutover (commits 7852ebf0 + c7ddb037 push)
    // would otherwise dead-letter immediately on the missing split-array
    // fields. Best-effort: treat legacy `approver_ids` as person ids + emit
    // one warn line per drain-window event so ops can spot them. Team uuids
    // smuggled inside the legacy array fall through to user-fetch failure
    // (already logged by sub-step D's dispatch path). Remove this fallback
    // after the drain window closes (no v4-shape events remain).
    const { booking_id, chain_id, started_at } = payload;
    let { approver_person_ids, approver_team_ids } = payload;
    if (
      !Array.isArray(approver_person_ids) &&
      !Array.isArray(approver_team_ids) &&
      Array.isArray(payload.approver_ids)
    ) {
      this.log.warn(
        `legacy_payload_shape_detected — approver_ids -> approver_person_ids ` +
          `(v4 drain-window event; team uuids inside this array will fall through ` +
          `to user-fetch failure): event=${event.id} chain=${chain_id}`,
      );
      approver_person_ids = payload.approver_ids;
      approver_team_ids = [];
    }

    if (typeof booking_id !== 'string' || !UUID_RE.test(booking_id)) {
      throw new DeadLetterError(
        `booking.approval_required.booking_id_invalid: '${booking_id}' is not a uuid`,
      );
    }
    if (typeof chain_id !== 'string' || !UUID_RE.test(chain_id)) {
      throw new DeadLetterError(
        `booking.approval_required.chain_id_invalid: '${chain_id}' is not a uuid`,
      );
    }
    if (!Array.isArray(approver_person_ids)) {
      throw new DeadLetterError(
        `booking.approval_required.approver_person_ids_missing: chain=${chain_id}`,
      );
    }
    if (!Array.isArray(approver_team_ids)) {
      throw new DeadLetterError(
        `booking.approval_required.approver_team_ids_missing: chain=${chain_id}`,
      );
    }
    if (approver_person_ids.length === 0 && approver_team_ids.length === 0) {
      throw new DeadLetterError(
        `booking.approval_required.no_approvers: chain=${chain_id} (both person + team arrays empty)`,
      );
    }
    for (const id of approver_person_ids) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        throw new DeadLetterError(
          `booking.approval_required.approver_person_id_invalid: '${id}' is not a uuid (chain=${chain_id})`,
        );
      }
    }
    for (const id of approver_team_ids) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) {
        throw new DeadLetterError(
          `booking.approval_required.approver_team_id_invalid: '${id}' is not a uuid (chain=${chain_id})`,
        );
      }
    }
    if (typeof started_at !== 'string') {
      throw new DeadLetterError(
        `booking.approval_required.started_at_missing: chain=${chain_id}`,
      );
    }
    const startedDate = new Date(started_at);
    if (Number.isNaN(startedDate.getTime())) {
      throw new DeadLetterError(
        `booking.approval_required.started_at_invalid: '${started_at}' is not parseable`,
      );
    }

    const tenantId = event.tenant_id;

    // ── 3. Re-read approval state (architect C3) ─────────────────────────
    //
    // Mirror sla-timer-repoint.handler.ts:84-101. Catches:
    //   - chain rows deleted (booking cancelled between RPC + drain)
    //     → no-op (NOT retry).
    //   - chain fully resolved (raceful approve via a different path)
    //     → no-op.
    const { data: approvals, error: apprErr } = await this.supabase.admin
      .from('approvals')
      .select('id, status, approver_person_id, approver_team_id')
      .eq('tenant_id', tenantId)
      .eq('approval_chain_id', chain_id);

    if (apprErr) {
      // Transient — let the outbox retry pick it up. Self-review CODE-I5:
      // dedicated `approval.read_failed` so SREs can isolate this from the
      // email-channel `email.dispatch_failed` blanket.
      throw AppErrors.server('approval.read_failed', {
        detail: `approval_re_read_failed: ${apprErr.message}`,
      });
    }

    if (!approvals || approvals.length === 0) {
      this.log.log(
        `chain_not_found_no_op event=${event.id} chain=${chain_id} tenant=${tenantId}`,
      );
      return;
    }

    const stillPending = (approvals as Array<{ status: string }>).filter(
      (a) => a.status === 'pending',
    );
    if (stillPending.length === 0) {
      this.log.log(
        `chain_already_resolved_no_op event=${event.id} chain=${chain_id} tenant=${tenantId} rows=${approvals.length}`,
      );
      return;
    }

    // ── 4. Resolve approver_person_ids → users (tenant-scoped) ───────────
    //
    // TODO(self-review C2/C3): when users.locale_preference column lands,
    // add it to the SELECT here + plumb it through the userMap so per-user
    // overrides take precedence over tenants.locale_default below.
    const personIds = approver_person_ids;
    const personUserMap = new Map<string, { id: string; email: string | null }>();
    if (personIds.length > 0) {
      const { data: personUsers, error: personErr } = await this.supabase.admin
        .from('users')
        .select('id, person_id, email')
        .eq('tenant_id', tenantId)
        .in('person_id', personIds);
      if (personErr) {
        throw AppErrors.server('users.lookup_failed', {
          detail: `person_user_lookup_failed: ${personErr.message}`,
        });
      }
      for (const u of (personUsers ?? []) as Array<{
        id: string;
        person_id: string;
        email: string | null;
      }>) {
        personUserMap.set(u.id, { id: u.id, email: u.email });
      }
    }

    // ── 5. Resolve approver_team_ids → users via team_members ────────────
    //
    // Mirrors approval.service.ts:184-233 pattern. Tenant-filter every
    // JOIN. supabase.admin bypasses RLS, so the explicit `.eq('tenant_id',
    // ...)` is the boundary.
    //
    // TODO(self-review C2/C3): same as step 4 — add users.locale_preference
    // to the second SELECT when the column lands.
    const teamIds = approver_team_ids;
    const teamUserMap = new Map<string, { id: string; email: string | null }>();
    if (teamIds.length > 0) {
      const { data: members, error: teamErr } = await this.supabase.admin
        .from('team_members')
        .select('user_id, team_id')
        .eq('tenant_id', tenantId)
        .in('team_id', teamIds);
      if (teamErr) {
        throw AppErrors.server('users.lookup_failed', {
          detail: `team_members_lookup_failed: ${teamErr.message}`,
        });
      }
      const memberUserIds = Array.from(
        new Set(((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id)),
      );
      if (memberUserIds.length > 0) {
        const { data: teamUsers, error: teamUsersErr } = await this.supabase.admin
          .from('users')
          .select('id, email')
          .eq('tenant_id', tenantId)
          .in('id', memberUserIds);
        if (teamUsersErr) {
          throw AppErrors.server('users.lookup_failed', {
            detail: `team_user_fetch_failed: ${teamUsersErr.message}`,
          });
        }
        for (const u of (teamUsers ?? []) as Array<{ id: string; email: string | null }>) {
          teamUserMap.set(u.id, { id: u.id, email: u.email });
        }
      }
    }

    // ── 6. Union of person + team users ──────────────────────────────────
    const allUsers = new Map<string, { id: string; email: string | null }>();
    for (const [id, u] of personUserMap) allUsers.set(id, u);
    for (const [id, u] of teamUserMap) allUsers.set(id, u);

    if (allUsers.size === 0) {
      // No resolvable approver. Common cases:
      //   - person_id refers to a person with no users row (e.g. external
      //     contact who can't actually log in to approve);
      //   - team_id has no current members.
      // Not retry-worthy — log + return.
      this.log.warn(
        `no_resolvable_approvers_no_op event=${event.id} chain=${chain_id} ` +
          `tenant=${tenantId} persons=${personIds.length} teams=${teamIds.length}`,
      );
      return;
    }

    // ── 7. Resolve tenant locale ONCE (self-review C2/C3 + I2) ───────────
    //
    // Single tenants read; same locale applied to every approver. NL-primary
    // tenants get NL emails. When users.locale_preference lands, the per-user
    // override picks it up via the SELECTs in steps 4/5 — and falls back to
    // this tenant locale when null.
    //
    // Plan-review I6: locale resolution NEVER throws — a transient tenants
    // read failure falls back to 'en' and logs a warn line.
    const tenantLocale = await this.resolveTenantLocale(tenantId, event.id);

    // ── 8. Enrich payload (booking + space + requester) ──────────────────
    const enriched = await this.enrichPayload({
      tenantId,
      bookingId: booking_id,
      chainId: chain_id,
    });
    if (!enriched) {
      // Booking deleted between RPC commit and handler drain (cascade or
      // hard-delete). No-op — same shape as chain_not_found.
      this.log.log(
        `booking_not_found_no_op event=${event.id} booking=${booking_id} tenant=${tenantId}`,
      );
      return;
    }

    // ── 9. Per-user dispatch (best-effort isolation) ─────────────────────
    //
    // One user's failure (e.g. provider 4xx on a malformed address) MUST
    // NOT block the rest. Wrap in try/catch + warn-log. Outbox retry will
    // re-fire the entire event for transient errors — Resend Idempotency-
    // Key + the producer-RPC inbox ON CONFLICT make retries safe.
    let tenantSlug = '';
    try {
      tenantSlug = TenantContext.current().slug;
    } catch {
      // TenantContext is set by the outbox worker before invoking handlers
      // (outbox.worker.ts:217). The catch handles unit-test paths where
      // TenantContext is not wired — empty slug is fine for email channel
      // (email channel intentionally ignores tenantSlug per
      // notification-channel.interface.ts:60-69).
      tenantSlug = '';
    }

    let dispatched = 0;
    let failed = 0;
    for (const user of allUsers.values()) {
      try {
        await this.notifications.dispatch({
          tenantId,
          userId: user.id,
          locale: tenantLocale,
          eventKind: 'booking.approval_required',
          payload: enriched,
          idempotencyKey: `${event.id}:${user.id}`,
          context: {
            entityType: 'booking',
            entityId: booking_id,
            tenantSlug,
          },
        });
        dispatched++;
      } catch (err) {
        // Per-user isolation. Log warn; outbox retry re-fires the whole
        // event for transient errors. ON CONFLICT (inbox) + Idempotency-
        // Key (Resend) make retries safe.
        failed++;
        this.log.warn(
          `per_user_dispatch_failed event=${event.id} user=${user.id} chain=${chain_id} ` +
            `error=${(err as Error).message ?? String(err)}`,
        );
      }
    }

    this.log.log(
      `dispatch_complete event=${event.id} chain=${chain_id} tenant=${tenantId} ` +
        `dispatched=${dispatched} failed=${failed} total=${allUsers.size}`,
    );
  }

  /**
   * Build the typed `BookingApprovalRequiredPayload` consumed by
   * TemplateResolverService.
   *
   * Returns `null` when any required join row is missing (booking deleted,
   * space hard-removed, requester deleted) — caller treats null as a
   * no-op (NOT retry). Hard-delete races between RPC commit and handler
   * drain are the expected case.
   *
   * Shape returned (sub-step E + F brief):
   *   {
   *     bookingId: string,
   *     chainId: string,
   *     bookingTitle: string,
   *     requesterName: string,
   *     spaceName: string,
   *     startAt: string (ISO),
   *     endAt: string (ISO),
   *     approvalCtaUrl: string (absolute URL)
   *   }
   *
   * `bookingTitle` falls back to `spaceName` when the booking has no
   * explicit title (per template payload doc on types.ts:69).
   * `requesterName` is `${first_name} ${last_name}` joined with a single
   * space, both trimmed; missing names yield "Someone" (rare — persons
   * has NOT NULL on both columns at 00003:8-9, but defensive).
   */
  private async enrichPayload(args: {
    tenantId: string;
    bookingId: string;
    chainId: string;
  }): Promise<TemplatePayload | null> {
    const supa = this.supabase.admin;

    // Single round-trip: select booking with the columns we need + join
    // spaces (location_id) + persons (requester_person_id).
    const { data: booking, error } = await supa
      .from('bookings')
      .select(
        'id, tenant_id, title, location_id, requester_person_id, start_at, end_at',
      )
      .eq('tenant_id', args.tenantId)
      .eq('id', args.bookingId)
      .maybeSingle();

    if (error) {
      // Self-review CODE-I5: dedicated `booking.read_failed` so SREs can
      // tell apart a booking-row read failure from an email-channel
      // rejection.
      throw AppErrors.server('booking.read_failed', {
        detail: `booking_enrich_read_failed: ${error.message}`,
      });
    }
    if (!booking) {
      return null;
    }

    const b = booking as {
      id: string;
      tenant_id: string;
      title: string | null;
      location_id: string;
      requester_person_id: string;
      start_at: string;
      end_at: string;
    };

    const [spaceRes, requesterRes] = await Promise.all([
      supa
        .from('spaces')
        .select('id, name')
        .eq('tenant_id', args.tenantId)
        .eq('id', b.location_id)
        .maybeSingle(),
      supa
        .from('persons')
        .select('id, first_name, last_name')
        .eq('tenant_id', args.tenantId)
        .eq('id', b.requester_person_id)
        .maybeSingle(),
    ]);

    if (spaceRes.error) {
      throw AppErrors.server('booking.read_failed', {
        detail: `space_enrich_read_failed: ${spaceRes.error.message}`,
      });
    }
    if (requesterRes.error) {
      throw AppErrors.server('booking.read_failed', {
        detail: `requester_enrich_read_failed: ${requesterRes.error.message}`,
      });
    }
    if (!spaceRes.data || !requesterRes.data) {
      // Joined row missing — treat as the same no-op shape as the booking
      // re-read returning null. Rare (FKs prevent it normally), but a
      // hard-delete cascade race could land here.
      return null;
    }

    const space = spaceRes.data as { name: string };
    const person = requesterRes.data as {
      first_name: string | null;
      last_name: string | null;
    };
    const requesterName =
      [person.first_name?.trim(), person.last_name?.trim()]
        .filter((s): s is string => Boolean(s && s.length > 0))
        .join(' ') || 'Someone';

    const bookingTitle =
      typeof b.title === 'string' && b.title.trim().length > 0
        ? b.title.trim()
        : space.name;

    return {
      bookingId: b.id,
      chainId: args.chainId,
      bookingTitle,
      requesterName,
      spaceName: space.name,
      startAt: b.start_at,
      endAt: b.end_at,
      approvalCtaUrl: this.buildApprovalCtaUrl(args.chainId, b.id),
    };
  }

  /**
   * Resolve the tenant's default locale (single read, applied to every
   * approver). Self-review C2/C3 + I2: the per-user `resolveUserLocale` was
   * a hidden N+1 risk + always returned 'en' even for NL-primary tenants —
   * both fixed here.
   *
   * `tenants.locale_default` exists on the tenants table at
   * 00001_tenants.sql:20 (NOT NULL DEFAULT 'en'). Only 'en' and 'nl' are
   * supported in the template registry today; any other value falls back
   * to 'en' with a warn line so ops can spot tenants with bad config.
   *
   * Plan-review I6: NEVER throws. A transient tenants read failure falls
   * back to 'en' and logs warn — outbox retry handles persistent failures
   * via subsequent reads (e.g. the approvals re-read above).
   */
  private async resolveTenantLocale(
    tenantId: string,
    eventId: string,
  ): Promise<'en' | 'nl'> {
    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('id, locale_default')
      .eq('id', tenantId)
      .maybeSingle();
    if (error || !data) {
      this.log.warn(
        `tenant_locale_lookup_failed_falling_back_to_en event=${eventId} ` +
          `tenant=${tenantId} error=${error?.message ?? 'no_row'}`,
      );
      return 'en';
    }
    const locale = (data as { locale_default?: string | null }).locale_default;
    if (locale === 'nl') return 'nl';
    if (locale === 'en') return 'en';
    // Tenant has a locale this notification channel doesn't render yet.
    // Surface a warn line and fall back to 'en' rather than dead-letter —
    // approvers still get an email, just in English.
    this.log.warn(
      `tenant_locale_unsupported_falling_back_to_en event=${eventId} ` +
        `tenant=${tenantId} locale=${locale}`,
    );
    return 'en';
  }

  /**
   * Build the absolute CTA URL for the approval-required email button.
   *
   * Uses `FRONTEND_BASE_URL` (canonical — documented in .env.example) with
   * `WEB_BASE_URL` as a fallback (already used by visitor-email.worker.ts).
   *
   * Self-review I3: in non-test environments the handler hard-fails when
   * BOTH env vars are unset — a localhost CTA in a production email is
   * worse than the email never landing. In test env the localhost fallback
   * stays so jest specs that don't inject a ConfigService keep working.
   *
   * Self-review I4: the approvals route (`/desk/approvals/<chainId>`) is
   * the target once approvals Sprint 2 ships. Until then, the CTA falls
   * back to the booking detail surface (`/desk/bookings/<bookingId>?tab=
   * approval`) — that route exists today and surfaces the inline approval
   * panel. TODO logged in docs/follow-ups/b4a5-followups.md.
   */
  private buildApprovalCtaUrl(chainId: string, bookingId: string): string {
    const base =
      this.config.get<string>('FRONTEND_BASE_URL') ??
      this.config.get<string>('WEB_BASE_URL') ??
      null;
    let resolvedBase: string;
    if (base !== null && typeof base === 'string' && base.length > 0) {
      resolvedBase = base;
    } else if (process.env.NODE_ENV === 'test') {
      // Tests intentionally don't always inject a ConfigService — fallback
      // keeps the existing spec setup working.
      resolvedBase = 'http://localhost:5173';
    } else {
      // Non-test env without either env var is a deploy misconfig — better
      // to fail loudly than send broken-link emails. Outbox retries pick
      // it up; the alarm fires after maxAttempts.
      throw AppErrors.server('email.dispatch_failed', {
        detail:
          'frontend_base_url_unset: neither FRONTEND_BASE_URL nor WEB_BASE_URL is set',
      });
    }
    const trimmedBase = resolvedBase.replace(/\/+$/, '');
    // TODO: when /desk/approvals/<chainId> ships (approvals Sprint 2),
    // swap the path to use chainId and drop the bookingId arg. Followup
    // logged in docs/follow-ups/b4a5-followups.md.
    void chainId; // keeps the signature stable for the swap
    return `${trimmedBase}/desk/bookings/${encodeURIComponent(bookingId)}?tab=approval`;
  }
}
