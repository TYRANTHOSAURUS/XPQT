import 'reflect-metadata';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  OUTBOX_HANDLER_META,
  type OutboxEventHandler,
  type OutboxHandlerMeta,
} from './outbox-handler.decorator';

/**
 * Decorator-driven handler registry.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §9 (N1 fold).
 *
 * Why DiscoveryService instead of a central `providers: [...handlers]` map:
 * registration must NOT live in a single file that every handler PR has to
 * touch (merge-conflict hot spot, reviewer fatigue). With DiscoveryService
 * each handler module is self-contained — declare the class, slap on the
 * decorator, register the provider in its own module, done. The registry
 * walks the DI graph at OnModuleInit and indexes by `${eventType}@v${version}`.
 *
 * Lookup contract: `get(eventType, version)` returns the registered instance
 * OR `null` (NOT undefined). The worker uses null as the "no handler →
 * dead-letter immediately with reason='no_handler_registered'" signal.
 * Mismatched version is identical to missing handler — no automatic
 * fall-back to a sibling version. See §10 for rollout.
 */
@Injectable()
export class OutboxHandlerRegistry implements OnModuleInit {
  private readonly log = new Logger(OutboxHandlerRegistry.name);
  private readonly handlers = new Map<string, OutboxEventHandler>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const wrappers = this.discovery.getProviders();
    let registered = 0;

    for (const wrapper of wrappers) {
      const metatype = wrapper.metatype as { prototype: object } | null | undefined;
      if (!metatype) continue;

      const meta = Reflect.getMetadata(OUTBOX_HANDLER_META, metatype) as
        | OutboxHandlerMeta
        | undefined;
      if (!meta) continue;

      const instance = wrapper.instance as OutboxEventHandler | undefined;
      if (!instance) {
        this.log.warn(
          `outbox handler ${meta.eventType}@v${meta.version} has no instance — skipping (likely scoped/transient)`,
        );
        continue;
      }
      if (typeof (instance as { handle?: unknown }).handle !== 'function') {
        this.log.error(
          `outbox handler ${meta.eventType}@v${meta.version} missing handle() method`,
        );
        continue;
      }

      const key = this.key(meta.eventType, meta.version);
      if (this.handlers.has(key)) {
        // Two providers claim the same (eventType, version) — refuse to
        // pick a winner silently. The dispatch path can't be ambiguous.
        this.log.error(
          `outbox handler conflict: ${key} registered more than once; ignoring duplicate`,
        );
        continue;
      }
      this.handlers.set(key, instance);
      registered++;
    }

    // Spec §10.1 deploy verification — operators read this single line in the
    // pod startup logs to confirm every expected handler is wired before
    // advancing a version cutover. Format MUST stay stable.
    this.log.log(
      `registered ${registered} outbox handler(s): [${Array.from(this.handlers.keys()).sort().join(', ')}]`,
    );
  }

  /**
   * Lookup an instance for the (eventType, version) tuple. Returns null when
   * no handler is registered (the worker treats this as dead-letter with
   * reason='no_handler_registered').
   */
  get(eventType: string, version: number): OutboxEventHandler | null {
    return this.handlers.get(this.key(eventType, version)) ?? null;
  }

  /**
   * Test-only — total registered handlers. Stable across versions.
   */
  size(): number {
    return this.handlers.size;
  }

  /**
   * Test-only — explicit registration bypassing DiscoveryService. Used by
   * unit tests to wire fakes without spinning up a full Nest module.
   */
  registerForTest(eventType: string, version: number, handler: OutboxEventHandler): void {
    this.handlers.set(this.key(eventType, version), handler);
  }

  private key(eventType: string, version: number): string {
    return `${eventType}@v${version}`;
  }
}
