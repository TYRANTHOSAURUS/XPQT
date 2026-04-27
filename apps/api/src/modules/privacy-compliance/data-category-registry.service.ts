import { Injectable, Logger } from '@nestjs/common';
import type { DataCategoryAdapter } from './data-category.adapter';

/**
 * In-memory registry of DataCategoryAdapter implementations.
 *
 * Adapters self-register at module init via PrivacyComplianceModule providers.
 * The registry is the single source of truth for "which categories exist?"
 * — RetentionWorker iterates it, exports sweep it, erasure cascade walks it.
 *
 * Sprint 1 ships the registry empty. Sprint 2 wires real adapters per
 * gdpr-baseline-design.md §15.
 */
@Injectable()
export class DataCategoryRegistry {
  private readonly log = new Logger(DataCategoryRegistry.name);
  private readonly byCategory = new Map<string, DataCategoryAdapter>();

  /**
   * Register an adapter. Throws on duplicate category id — duplicates would
   * silently corrupt retention behaviour, so we fail loud at boot.
   */
  register(adapter: DataCategoryAdapter): void {
    if (this.byCategory.has(adapter.category)) {
      throw new Error(
        `DataCategoryRegistry: duplicate registration for "${adapter.category}"`,
      );
    }
    this.byCategory.set(adapter.category, adapter);
    this.log.log(`registered category: ${adapter.category}`);
  }

  get(category: string): DataCategoryAdapter | undefined {
    return this.byCategory.get(category);
  }

  /** All registered adapters. Order is registration order (insertion order). */
  all(): DataCategoryAdapter[] {
    return Array.from(this.byCategory.values());
  }

  /** Categories that the seed function knows about but no adapter is registered for yet. */
  unimplementedCategories(seededCategories: string[]): string[] {
    return seededCategories.filter((c) => !this.byCategory.has(c));
  }
}
