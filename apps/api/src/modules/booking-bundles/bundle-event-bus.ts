import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

/**
 * In-process event bus for bundle cascade fan-out.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §10
 *
 * Mirrors the VisitorEventBus pattern in `apps/api/src/modules/visitors/`.
 * BundleCascadeService emits on edit/cancel (slice 4 wiring); subscribers
 * (today: VisitorsModule's `BundleCascadeAdapter`) react to keep their
 * domain in sync per the §10.2 cascade matrix.
 *
 * Single-process only — fine for v1. A multi-instance deployment will need
 * to swap this for Postgres LISTEN/NOTIFY or Redis pub/sub; the public
 * surface stays the same so the swap is a one-file change.
 *
 * Why a separate bus from VisitorEventBus:
 *   - Different domain (booking-bundles owns it), different payload shape,
 *     different subscriber ownership.
 *   - Visitors module subscribes to BundleEventBus to react to bundle
 *     changes; it does NOT emit on this bus. Cleaner ownership boundary.
 *
 * Tenant safety: the payload carries `tenant_id` so subscribers can
 * defend against cross-tenant fan-out (e.g. the visitor adapter walks
 * its own data with a tenant filter).
 */

export type BundleEventKind =
  | 'bundle.line.moved'
  | 'bundle.line.room_changed'
  | 'bundle.line.cancelled'
  | 'bundle.cancelled';

interface BundleEventBase {
  tenant_id: string;
  bundle_id: string;
  /** Wall-clock for tracing. */
  occurred_at: string;
}

export interface BundleLineMovedEvent extends BundleEventBase {
  kind: 'bundle.line.moved';
  line_id: string;
  /** What kind of bundle line moved. v1 cares about 'visitor' for the cascade. */
  line_kind: 'visitor' | 'room' | 'catering' | 'av' | 'other';
  old_expected_at: string | null;
  new_expected_at: string;
}

export interface BundleLineRoomChangedEvent extends BundleEventBase {
  kind: 'bundle.line.room_changed';
  line_id: string;
  line_kind: 'visitor' | 'room' | 'catering' | 'av' | 'other';
  old_room_id: string | null;
  new_room_id: string | null;
}

export interface BundleLineCancelledEvent extends BundleEventBase {
  kind: 'bundle.line.cancelled';
  line_id: string;
  line_kind: 'visitor' | 'room' | 'catering' | 'av' | 'other';
}

export interface BundleCancelledEvent extends BundleEventBase {
  kind: 'bundle.cancelled';
}

export type BundleEvent =
  | BundleLineMovedEvent
  | BundleLineRoomChangedEvent
  | BundleLineCancelledEvent
  | BundleCancelledEvent;

@Injectable()
export class BundleEventBus {
  private readonly subject = new Subject<BundleEvent>();

  /** Stream of bundle cascade events. */
  get events$(): Observable<BundleEvent> {
    return this.subject.asObservable();
  }

  emit(event: BundleEvent): void {
    this.subject.next(event);
  }

  /** Test-only — fire a one-shot listener and capture emissions. */
  collectEvents(filter?: (e: BundleEvent) => boolean): {
    captured: BundleEvent[];
    unsubscribe: () => void;
  } {
    const captured: BundleEvent[] = [];
    const sub = this.subject.subscribe((e) => {
      if (!filter || filter(e)) captured.push(e);
    });
    return { captured, unsubscribe: () => sub.unsubscribe() };
  }
}
