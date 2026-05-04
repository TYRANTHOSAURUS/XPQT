import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';

/**
 * Phase 1.3 — Bug #1: Atomic Booking + Service via RPC + Boundary.
 *
 * The booking-flow pipeline is two writes from the app's perspective:
 *   1. `create_booking` RPC (00277:236-334) — inserts booking + slots atomically.
 *   2. `BundleService.attachServicesToBooking` — inserts orders + lines + asset
 *      reservations + approvals across many sequential supabase-js calls.
 *
 * Postgres atomicity stops at the RPC boundary. If step 2 fails, step 1's
 * booking persists and the user gets a "service attach failed" response while
 * the room is silently still reserved. The blocker map at
 * docs/follow-ups/phase-1-3-blocker-map.md enumerates what state may exist at
 * compensation time; the `delete_booking_with_guard` RPC (migration 00292)
 * encodes the safe-rollback decision.
 *
 * This boundary wraps step 2: it runs `operation`; if it throws, it calls
 * `compensate(bookingId)` which talks to the RPC and surfaces a structured
 * `CompensationOutcome`. The boundary then either:
 *   - 'rolled_back'      → re-throw the ORIGINAL operation error so the
 *                          caller sees the same exception they would have
 *                          without compensation (e.g. "catalog_item_not_found").
 *   - 'partial_failure'  → throw a BadRequestException with code
 *                          'booking.partial_failure', surfacing booking_id +
 *                          blocked_by[] so the operator can manually finish
 *                          the rollback (e.g. cancel the recurrence series
 *                          first, then retry compensation).
 *
 * Phase 7 will register `booking.partial_failure` in the AppError catalog
 * and re-flow this through the formal exception-mapper. Today we throw raw
 * NestJS exceptions per the plan's D4 decision.
 *
 * Phase 6 will replace `InProcessBookingTransactionBoundary` with a
 * durable-outbox-driven impl while keeping this interface stable so call
 * sites (BookingFlowService, MultiRoomBookingService) don't change.
 */

/** Structured result of a compensation attempt. */
export type CompensationOutcome =
  | { kind: 'rolled_back'; bookingId: string }
  | { kind: 'partial_failure'; bookingId: string; blockedBy: string[] };

/**
 * The compensation boundary contract. Wraps a sequential post-create operation
 * (typically `attachServicesToBooking`) so a failure mid-flight rolls back the
 * already-landed booking via the `delete_booking_with_guard` RPC.
 */
export interface BookingTransactionBoundary {
  runWithCompensation<T>(
    bookingId: string,
    operation: () => Promise<T>,
    compensate: (bookingId: string) => Promise<CompensationOutcome>,
  ): Promise<T>;
}

/** DI token. NestJS can't resolve interface types at runtime — see
 *  reservations.module.ts for the `{ provide: BOOKING_TX_BOUNDARY, useClass:
 *  InProcessBookingTransactionBoundary }` registration. */
export const BOOKING_TX_BOUNDARY = 'BookingTransactionBoundary';

/**
 * In-process implementation. No durability — if the Node process crashes
 * between operation-throw and compensation-call, the booking is orphaned.
 * Phase 6 replaces this with an outbox-driven impl that survives restarts.
 *
 * Logger is module-internal; the boundary itself never logs the original
 * error contents (that's the caller's job — typically the service that
 * raised it). Compensation outcomes ARE logged at warn so operators can
 * diagnose silent rollbacks.
 */
@Injectable()
export class InProcessBookingTransactionBoundary implements BookingTransactionBoundary {
  private readonly log = new Logger(InProcessBookingTransactionBoundary.name);

  async runWithCompensation<T>(
    bookingId: string,
    operation: () => Promise<T>,
    compensate: (bookingId: string) => Promise<CompensationOutcome>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (originalErr) {
      // Step 2 failed. Try to roll back step 1 via the compensation RPC.
      // Per blocker-map line 91 + RPC pseudocode at lines 86-117, the RPC
      // returns either 'rolled_back' (booking + cascades deleted) or
      // 'partial_failure' (a recurrence_series exists; manual recovery
      // needed).
      let outcome: CompensationOutcome;
      try {
        outcome = await compensate(bookingId);
      } catch (compErr) {
        // The compensation RPC itself blew up. We can't roll back; surface
        // the compensation failure as a server error so the original
        // operation's exception isn't masked. The booking is in an
        // unknown state — the manual smoke runbook documents the recovery
        // path (docs/follow-ups/phase-1-booking-smoke.md).
        this.log.error(
          `compensation RPC failed for booking ${bookingId}: ${
            (compErr as Error).message
          }; original error: ${(originalErr as Error).message}`,
        );
        throw new BadRequestException({
          code: 'booking.compensation_failed',
          message: 'Service attach failed; rollback failed; booking may persist.',
          booking_id: bookingId,
          original_error: (originalErr as Error).message,
          compensation_error: (compErr as Error).message,
        });
      }

      if (outcome.kind === 'rolled_back') {
        // Booking + cascades are gone. Re-throw the original error so the
        // user sees the same exception they would have without
        // compensation (catalog_item_not_found, etc).
        this.log.warn(
          `booking ${bookingId} rolled back after operation failed: ${
            (originalErr as Error).message
          }`,
        );
        throw originalErr;
      }

      // 'partial_failure' — the booking still exists because a blocker
      // (recurrence_series, today) prevents safe deletion. Surface
      // booking_id + blocked_by[] so operators can manually finish
      // rollback (e.g. cancel the series, retry compensation).
      this.log.warn(
        `booking ${bookingId} partial_failure on compensation: blocked_by=${outcome.blockedBy.join(
          ',',
        )}; original error: ${(originalErr as Error).message}`,
      );
      throw new BadRequestException({
        code: 'booking.partial_failure',
        message:
          'Service attach failed; booking could not be fully rolled back. ' +
          'Manual recovery required.',
        booking_id: outcome.bookingId,
        blocked_by: outcome.blockedBy,
        original_error: (originalErr as Error).message,
      });
    }
  }
}

/**
 * Convenience param decorator for boundary injection. Equivalent to
 * `@Inject(BOOKING_TX_BOUNDARY) txBoundary: BookingTransactionBoundary`.
 * Used in service constructors to keep the inject keyword inline.
 */
export const InjectBookingTxBoundary = () => Inject(BOOKING_TX_BOUNDARY);
