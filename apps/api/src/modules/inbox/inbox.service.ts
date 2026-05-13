import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors } from '../../common/errors';
import type { BookingApprovalRequiredPayload } from '../notifications/templates/types';
import {
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  type InboxCountResponse,
  type InboxItemDto,
  type InboxListResponse,
} from './dto/inbox-list.dto';
import type {
  InboxMarkAllReadResponse,
  InboxMarkReadResponse,
} from './dto/inbox-mark-read.dto';

/**
 * InboxService — read + mark-read surface for the per-(tenant, user)
 * `inbox_notifications` table.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step E.
 *
 * ── Why no permission gate ─────────────────────────────────────────────
 *
 * Per architect C1 + plan-review I2: every authenticated user reads their
 * own inbox. The schema-level RLS on `inbox_notifications` already bridges
 * `auth.uid()` → `users.auth_uid` → `users.id` within `current_tenant_id()`
 * (00391 lines 79-99). Permission keys would be a redundant gate.
 *
 * ── Why explicit tenant_id + user_id filters anyway ────────────────────
 *
 * This service uses `supabase.admin` (RLS BYPASSED). The explicit
 * `eq('tenant_id', …).eq('user_id', …)` predicates ARE the contract here
 * — RLS only protects requests that come through the JWT-scoped client.
 * Tenant_id is the #0 invariant (memory: feedback_tenant_id_ultimate_rule);
 * every read AND write below filters on both.
 *
 * ── Why no audit_events writes on mark-read ────────────────────────────
 *
 * Per architect N1 + plan-review I3: read flips are operational metrics,
 * not compliance state. Polluting the 7-year audit retention with
 * read-receipt churn would bloat the table for no compliance value.
 *
 * ── Cursor format ─────────────────────────────────────────────────────
 *
 * Opaque base64url(`<created_atISO>:<id>`). Order: `created_at DESC, id
 * DESC`. The next-page predicate is the lexicographic tuple compare
 * `(created_at, id) < (cursor.created_at, cursor.id)`. Implemented via
 * supabase-js `.or('created_at.lt.X,and(created_at.eq.X,id.lt.Y)')`.
 *
 * Citations:
 *   - supabase/migrations/00391_inbox_notifications.sql:34-99
 *       table + indexes + RLS (auth.uid → users.auth_uid → users.id bridge).
 *   - apps/api/src/modules/portal-announcements/portal-announcements.service.ts:62-70
 *       canonical auth_uid → users.id resolution pattern (also used in
 *       ticket-visibility.service.ts:127-130 / calendar-sync.service.ts).
 *   - apps/api/src/modules/notifications/templates/types.ts:64-85
 *       BookingApprovalRequiredPayload — typed shape for summary rendering.
 *   - reservation.service.ts (listMine, circa lines 230-249) — sibling
 *       cursor-pagination implementation with `(start_at, id)` tuple
 *       compare via PostgREST .or(). Adapted for the inbox
 *       `(created_at DESC, id DESC)` shape below.
 */
@Injectable()
export class InboxService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Resolve the JWT's `auth.uid()` to a `(tenant_id, users.id)` actor pair.
   * Throws `inbox.not_resolvable` (401) when the bridge is missing — the
   * token is valid but the user isn't a member of the current tenant.
   *
   * Caller passes `req.user.id` (the supabase auth_uid).
   */
  async resolveActor(authUid: string): Promise<{ tenantId: string; userId: string }> {
    const tenantId = TenantContext.current().id;
    const lookup = await (this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('auth_uid', authUid) as unknown as {
      maybeSingle: () => Promise<{ data: { id: string } | null; error: unknown }>;
    }).maybeSingle();
    if (lookup.error) {
      throw AppErrors.server('unknown.server_error', { cause: lookup.error });
    }
    const userId = lookup.data?.id;
    if (!userId) {
      throw AppErrors.unauthorized('inbox.not_resolvable');
    }
    return { tenantId, userId };
  }

  async list(
    actor: { tenantId: string; userId: string },
    args: { cursor?: string; limit?: number },
  ): Promise<InboxListResponse> {
    const limit = clampLimit(args.limit);

    let q = this.supabase.admin
      .from('inbox_notifications')
      .select('id, event_kind, payload, read_at, created_at')
      .eq('tenant_id', actor.tenantId)
      .eq('user_id', actor.userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (args.cursor) {
      const decoded = decodeCursor(args.cursor);
      if (decoded) {
        // Lexicographic tuple compare: (created_at, id) < (decoded.created_at, decoded.id).
        // PostgREST .or() pattern mirrors the sibling reservation listMine cursor.
        q = q.or(
          `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
        );
      }
    }

    const { data, error } = await q;
    if (error) {
      throw AppErrors.server('unknown.server_error', { cause: error });
    }

    type Row = {
      id: string;
      event_kind: string;
      payload: Record<string, unknown> | null;
      read_at: string | null;
      created_at: string;
    };
    const rows = ((data ?? []) as Row[]);

    // limit+1 fetch — peel off the trailing row to compute nextCursor.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items: InboxItemDto[] = page.map((row) => ({
      id: row.id,
      eventKind: row.event_kind,
      payload: row.payload ?? {},
      readAt: row.read_at,
      createdAt: row.created_at,
      summary: renderSummary(row.event_kind, row.payload ?? {}),
    }));

    const nextCursor = hasMore && page.length > 0
      ? encodeCursor({
          createdAt: page[page.length - 1].created_at,
          id: page[page.length - 1].id,
        })
      : null;

    return { items, nextCursor };
  }

  async count(actor: { tenantId: string; userId: string }): Promise<InboxCountResponse> {
    // Two parallel HEAD COUNT queries — both gated by tenant + user.
    const [unreadRes, totalRes] = await Promise.all([
      this.supabase.admin
        .from('inbox_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', actor.tenantId)
        .eq('user_id', actor.userId)
        .is('read_at', null),
      this.supabase.admin
        .from('inbox_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', actor.tenantId)
        .eq('user_id', actor.userId),
    ]);

    if (unreadRes.error) {
      throw AppErrors.server('unknown.server_error', { cause: unreadRes.error });
    }
    if (totalRes.error) {
      throw AppErrors.server('unknown.server_error', { cause: totalRes.error });
    }

    return {
      unread: unreadRes.count ?? 0,
      total: totalRes.count ?? 0,
    };
  }

  /**
   * Mark a single inbox row as read. Idempotent: re-marking returns the
   * existing `read_at` (never overwrites).
   *
   * Cross-tenant defense: the `(id, tenant_id, user_id)` filter triple
   * means a foreign-tenant id surfaces as `inbox_notification.not_found`
   * (404) — does NOT leak existence per spec §6.1.
   *
   * Implementation: read first to detect already-read state (so we can
   * return the existing timestamp without a second roundtrip when the
   * UPDATE would have written nothing). Then conditional UPDATE filters
   * `is('read_at', null)` to keep the write atomic — even if a sibling
   * tab just marked it, we re-read to surface that timestamp.
   */
  async markRead(
    actor: { tenantId: string; userId: string },
    id: string,
  ): Promise<InboxMarkReadResponse> {
    // Read first — both for the not-found check and to capture an existing
    // read_at if the row is already read.
    const existingRes = await this.supabase.admin
      .from('inbox_notifications')
      .select('id, read_at')
      .eq('tenant_id', actor.tenantId)
      .eq('user_id', actor.userId)
      .eq('id', id)
      .maybeSingle();

    if (existingRes.error) {
      throw AppErrors.server('unknown.server_error', { cause: existingRes.error });
    }
    const existing = existingRes.data as { id: string; read_at: string | null } | null;
    if (!existing) {
      // Foreign-tenant or genuinely missing — same surface (no existence leak).
      throw AppErrors.notFoundWithCode('inbox_notification.not_found', `inbox_notification ${id} not found`);
    }
    if (existing.read_at) {
      return { id: existing.id, readAt: existing.read_at };
    }

    const nowIso = new Date().toISOString();
    const updRes = await this.supabase.admin
      .from('inbox_notifications')
      .update({ read_at: nowIso })
      .eq('tenant_id', actor.tenantId)
      .eq('user_id', actor.userId)
      .eq('id', id)
      .is('read_at', null)
      .select('id, read_at')
      .maybeSingle();

    if (updRes.error) {
      throw AppErrors.server('unknown.server_error', { cause: updRes.error });
    }
    const updated = updRes.data as { id: string; read_at: string | null } | null;

    // The conditional update returned no row — a sibling tab raced ahead and
    // wrote read_at between our SELECT and UPDATE. Re-read to surface the
    // sibling's timestamp (idempotent contract).
    if (!updated) {
      const refetchRes = await this.supabase.admin
        .from('inbox_notifications')
        .select('id, read_at')
        .eq('tenant_id', actor.tenantId)
        .eq('user_id', actor.userId)
        .eq('id', id)
        .maybeSingle();
      if (refetchRes.error) {
        throw AppErrors.server('unknown.server_error', { cause: refetchRes.error });
      }
      const refetched = refetchRes.data as { id: string; read_at: string | null } | null;
      if (!refetched || !refetched.read_at) {
        // Should be impossible — row was here at first SELECT, wasn't deleted
        // (no DELETE path in v1), and the conditional UPDATE skipped it.
        // Treat as transient.
        throw AppErrors.server('unknown.server_error', {
          detail: `inbox.mark_read race irreconcilable id=${id}`,
        });
      }
      return { id: refetched.id, readAt: refetched.read_at };
    }

    if (!updated.read_at) {
      // Should be impossible — we just wrote a non-null timestamp.
      throw AppErrors.server('unknown.server_error', {
        detail: `inbox.mark_read returned null read_at id=${id}`,
      });
    }
    return { id: updated.id, readAt: updated.read_at };
  }

  /**
   * Mark all unread rows for the current actor as read. Returns the count
   * of rows transitioned (already-read rows are not re-touched). Idempotent.
   *
   * Implementation: conditional UPDATE filters `is('read_at', null)` so a
   * second call returns `{ marked: 0 }` cleanly.
   */
  async markAllRead(
    actor: { tenantId: string; userId: string },
  ): Promise<InboxMarkAllReadResponse> {
    const nowIso = new Date().toISOString();
    const res = await this.supabase.admin
      .from('inbox_notifications')
      .update({ read_at: nowIso })
      .eq('tenant_id', actor.tenantId)
      .eq('user_id', actor.userId)
      .is('read_at', null)
      .select('id');

    if (res.error) {
      throw AppErrors.server('unknown.server_error', { cause: res.error });
    }
    const marked = (res.data ?? []).length;
    return { marked };
  }
}

// ── Helpers (module-private) ─────────────────────────────────────────────

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return INBOX_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), INBOX_MAX_LIMIT);
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(c: DecodedCursor): string {
  // base64url with no padding so the cursor is URL-safe verbatim.
  const raw = `${c.createdAt}:${c.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    // ISO timestamps contain colons — split at the LAST colon to recover
    // the trailing uuid cleanly.
    const sep = raw.lastIndexOf(':');
    if (sep <= 0 || sep >= raw.length - 1) return null;
    const createdAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    // Sanity-check shape: ISO-8601 starts with a 4-digit year + dash; uuid
    // is 36 chars with dashes at fixed positions. Don't reject loosely-
    // formatted cursors silently — if the cursor decodes to obvious
    // garbage, treat it as "no cursor" and return the first page.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) return null;
    // The id is a uuid in production. Don't lock the regex to the canonical
    // uuid v4 shape — test fixtures use shorter ids, and an over-tight regex
    // here would mask a legitimate cursor coming back from the DB if the
    // id format ever evolves. The contract: non-empty, no embedded colon
    // (which would break the split), no whitespace.
    if (id.length === 0 || /[\s:]/.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Render a single-line summary for the bell-popover preview. For
 * `booking.approval_required` payloads we narrow on the typed shape;
 * unknown event kinds fall back to the eventKind string.
 *
 * Voice: subject-line, no HTML, no tenant-leakable detail. The full
 * payload is still returned in `payload` for the frontend's per-kind
 * view.
 */
function renderSummary(eventKind: string, payload: Record<string, unknown>): string {
  if (eventKind === 'booking.approval_required') {
    const p = payload as Partial<BookingApprovalRequiredPayload>;
    const title = typeof p.bookingTitle === 'string' && p.bookingTitle.trim() !== ''
      ? p.bookingTitle.trim()
      : null;
    const space = typeof p.spaceName === 'string' && p.spaceName.trim() !== ''
      ? p.spaceName.trim()
      : null;
    const startAt = typeof p.startAt === 'string' && p.startAt.trim() !== ''
      ? p.startAt.trim()
      : null;

    // Build the summary from whatever fields are present. The frontend
    // localizes display formatting (date / time tokens) — server-side
    // we ship the ISO timestamp verbatim so the client can format per
    // the user's locale + timezone.
    const lead = title ?? space ?? 'a booking';
    const where = title && space ? ` at ${space}` : '';
    const when = startAt ? ` on ${startAt}` : '';
    return `Approval needed: ${lead}${where}${when}`;
  }

  // Unknown event kind — return the kind verbatim. Frontend can register
  // additional kinds without a server roundtrip; the kind itself is a
  // stable identifier.
  return eventKind;
}
