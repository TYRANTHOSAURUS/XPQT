import 'reflect-metadata';
import type { OutboxEvent } from './outbox.types';

/**
 * Decorator + interface for outbox event handlers.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §9.
 *
 * Usage:
 *
 *   @Injectable()
 *   @OutboxHandler('booking.create_attempted', { version: 1 })
 *   export class BookingCreateAttemptedHandler implements OutboxEventHandler {
 *     async handle(event: OutboxEvent) { ... }
 *   }
 *
 * The registry walks all DI providers at module init, reads this decorator's
 * metadata, and indexes the instance under `${eventType}@v${version}`.
 *
 * Mismatch between emitted event_version and registered handler version
 * dead-letters the row with `dead_letter_reason = 'no_handler_registered'`
 * — the worker NEVER falls back to a different version. See §10 (versioning
 * rollout) for how to safely introduce a new version.
 */
export const OUTBOX_HANDLER_META = Symbol('outbox.handler');

export interface OutboxHandlerMeta {
  eventType: string;
  version: number;
}

export function OutboxHandler(
  eventType: string,
  opts?: { version?: number },
): ClassDecorator {
  return (target) => {
    const meta: OutboxHandlerMeta = {
      eventType,
      version: opts?.version ?? 1,
    };
    Reflect.defineMetadata(OUTBOX_HANDLER_META, meta, target);
  };
}

/**
 * Contract every handler implements. Throwing any non-`DeadLetterError`
 * error → retry per §4.4. Throwing `DeadLetterError` → immediate dead-letter
 * per §4.5.
 */
export interface OutboxEventHandler<TPayload = Record<string, unknown>> {
  handle(event: OutboxEvent<TPayload>): Promise<void>;
}
