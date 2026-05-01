import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

/**
 * In-process event bus for visitor SSE/realtime fan-out.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §9.4
 *
 * The codebase has no existing SSE / RealtimeService / EventEmitterService,
 * so this is the minimal primitive. Slice 2d's controller subscribes via
 * `@Sse('/visitors/host-events')` and pipes `events$` to the client.
 *
 * Single-process only — fine for v1 (Nest API runs as one instance per
 * region today). A multi-instance deployment will need to swap this for
 * Postgres LISTEN/NOTIFY or Redis pub/sub; the public surface stays the
 * same so swap is a one-file change.
 *
 * Privacy: payloads include visitor_id + host_person_id but no PII —
 * the host's open portal tab refetches the visitor row server-side
 * with normal RLS to actually display anything. The bus is just the
 * "wake up and refetch" signal.
 */

export interface HostNotificationEvent {
  /** Tenant scope — subscribers must filter on this. */
  tenant_id: string;
  /** Recipient host (used by SSE controller to scope subscriptions). */
  host_person_id: string;
  /** Visitor that triggered the event. */
  visitor_id: string;
  /** Event kind: arrival fan-out, acknowledgment by another host, etc. */
  kind: 'visitor.arrived' | 'visitor.acknowledged_by_other_host';
  /** Wall-clock for tracing. */
  occurred_at: string;
}

@Injectable()
export class VisitorEventBus {
  private readonly subject = new Subject<HostNotificationEvent>();

  /** Stream of all visitor-side events. Slice 2d's SSE controller filters. */
  get events$(): Observable<HostNotificationEvent> {
    return this.subject.asObservable();
  }

  emit(event: HostNotificationEvent): void {
    this.subject.next(event);
  }

  /** Test-only — fire a one-shot listener and capture emissions. */
  collectEvents(filter?: (e: HostNotificationEvent) => boolean): {
    captured: HostNotificationEvent[];
    unsubscribe: () => void;
  } {
    const captured: HostNotificationEvent[] = [];
    const sub = this.subject.subscribe((e) => {
      if (!filter || filter(e)) captured.push(e);
    });
    return { captured, unsubscribe: () => sub.unsubscribe() };
  }
}
