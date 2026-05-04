import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { OutboxHandler } from '../outbox-handler.decorator';
import { OutboxHandlerRegistry } from '../outbox-handler.registry';

/**
 * OutboxHandlerRegistry unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §9 (N1 fold)
 *       + §10 (versioning rollout).
 *
 * Scope:
 *   - DiscoveryService walk picks up @OutboxHandler-decorated providers.
 *   - Lookup is keyed by `(eventType, version)`.
 *   - Mismatched version returns null (worker treats as no_handler_registered).
 *   - Missing handler returns null.
 *   - Conflict detection — duplicate registration logs and ignores the second.
 *   - Wrappers without metatype, without instance, or without handle() are
 *     skipped without throwing.
 */

@Injectable()
@OutboxHandler('booking.create_attempted', { version: 1 })
class BookingHandlerV1 {
  async handle(): Promise<void> {
    /* no-op for tests */
  }
}

@Injectable()
@OutboxHandler('booking.create_attempted', { version: 2 })
class BookingHandlerV2 {
  async handle(): Promise<void> {
    /* no-op */
  }
}

@Injectable()
@OutboxHandler('notification.send_required')
class NotificationHandler {
  async handle(): Promise<void> {
    /* no-op */
  }
}

@Injectable()
class UndecoratedProvider {
  async handle(): Promise<void> {
    /* no-op */
  }
}

@Injectable()
@OutboxHandler('broken.handle_missing')
class HandleMissingHandler {
  // intentionally lacks .handle()
}

function makeRegistry(wrappers: Array<{ metatype: unknown; instance: unknown }>) {
  const discovery = {
    getProviders: () => wrappers,
  };
  return new OutboxHandlerRegistry(discovery as never);
}

describe('OutboxHandlerRegistry', () => {
  it('discovers and registers @OutboxHandler-decorated providers', () => {
    const v1 = new BookingHandlerV1();
    const v2 = new BookingHandlerV2();
    const notif = new NotificationHandler();
    const reg = makeRegistry([
      { metatype: BookingHandlerV1, instance: v1 },
      { metatype: BookingHandlerV2, instance: v2 },
      { metatype: NotificationHandler, instance: notif },
    ]);
    reg.onModuleInit();

    expect(reg.size()).toBe(3);
    expect(reg.get('booking.create_attempted', 1)).toBe(v1);
    expect(reg.get('booking.create_attempted', 2)).toBe(v2);
    expect(reg.get('notification.send_required', 1)).toBe(notif);
  });

  it('returns null when no handler matches the event type', () => {
    const reg = makeRegistry([
      { metatype: BookingHandlerV1, instance: new BookingHandlerV1() },
    ]);
    reg.onModuleInit();

    expect(reg.get('unknown.event', 1)).toBeNull();
  });

  it('returns null when the version does not match (no auto-fallback)', () => {
    // Spec §10.2 #3 — version mismatch must not silently fall back.
    const reg = makeRegistry([
      { metatype: BookingHandlerV1, instance: new BookingHandlerV1() },
    ]);
    reg.onModuleInit();

    // v2 not registered → null (worker dead-letters with reason='no_handler_registered').
    expect(reg.get('booking.create_attempted', 2)).toBeNull();
    expect(reg.get('booking.create_attempted', 1)).not.toBeNull();
  });

  it('skips undecorated providers without throwing', () => {
    const reg = makeRegistry([
      { metatype: UndecoratedProvider, instance: new UndecoratedProvider() },
      { metatype: BookingHandlerV1, instance: new BookingHandlerV1() },
    ]);
    reg.onModuleInit();

    expect(reg.size()).toBe(1);
  });

  it('skips wrappers without metatype', () => {
    const reg = makeRegistry([
      { metatype: null, instance: {} },
      { metatype: BookingHandlerV1, instance: new BookingHandlerV1() },
    ]);
    reg.onModuleInit();

    expect(reg.size()).toBe(1);
  });

  it('skips decorated providers whose instance is missing (e.g. transient/scoped)', () => {
    const reg = makeRegistry([
      { metatype: BookingHandlerV1, instance: undefined },
    ]);
    reg.onModuleInit();

    expect(reg.size()).toBe(0);
    expect(reg.get('booking.create_attempted', 1)).toBeNull();
  });

  it('skips decorated providers without a handle() method (defensive)', () => {
    const reg = makeRegistry([
      { metatype: HandleMissingHandler, instance: new HandleMissingHandler() },
    ]);
    reg.onModuleInit();

    expect(reg.size()).toBe(0);
  });

  it('refuses to silently overwrite on duplicate (eventType, version) registration', () => {
    const first = new BookingHandlerV1();
    const second = new BookingHandlerV1();
    const reg = makeRegistry([
      { metatype: BookingHandlerV1, instance: first },
      // Duplicate metatype reference shouldn't matter — the key is decorator
      // metadata. Same metadata → conflict.
      { metatype: BookingHandlerV1, instance: second },
    ]);
    reg.onModuleInit();

    // First registration wins; second is ignored.
    expect(reg.get('booking.create_attempted', 1)).toBe(first);
    expect(reg.size()).toBe(1);
  });

  it('emits a stable startup log line for deploy verification (spec §10.1)', () => {
    const reg = makeRegistry([
      { metatype: BookingHandlerV1, instance: new BookingHandlerV1() },
      { metatype: BookingHandlerV2, instance: new BookingHandlerV2() },
    ]);
    const logSpy = jest
      .spyOn((reg as unknown as { log: { log: jest.Mock } }).log, 'log')
      .mockImplementation(() => undefined);
    reg.onModuleInit();

    // Spec §10.1 — operators read this to confirm every pod has the new
    // handler version registered before advancing a cutover.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/registered 2 outbox handler\(s\)/);
    expect(logSpy.mock.calls[0][0]).toContain('booking.create_attempted@v1');
    expect(logSpy.mock.calls[0][0]).toContain('booking.create_attempted@v2');
  });

  it('registerForTest exposes a path for unit tests to wire fakes', () => {
    const reg = makeRegistry([]);
    reg.onModuleInit();

    const fake = { handle: async () => undefined };
    reg.registerForTest('synthetic.event', 1, fake);

    expect(reg.get('synthetic.event', 1)).toBe(fake);
  });
});
