import { SetMetadata } from '@nestjs/common';

/**
 * Method decorator marking a controller handler as PII-returning. The
 * companion PersonalDataAccessInterceptor reads this metadata after the
 * handler runs, builds an access-log entry, and queues it for batch
 * insertion.
 *
 * Example:
 *
 *   @LogPersonalDataAccess({
 *     dataCategory: 'past_bookings',
 *     resourceType: 'reservations',
 *     accessMethod: 'detail_view',
 *     subjectFromParams: (params) => params.id,            // person_id from route
 *   })
 *   @Get(':id')
 *   async getBooking(@Param('id') id: string) { ... }
 *
 * Spec: gdpr-baseline-design.md §7.
 */

export const LOG_PII_ACCESS_METADATA = 'gdpr:log-personal-data-access';

export interface LogPersonalDataAccessConfig {
  /** Matches a category in tenant_retention_settings / DataCategoryRegistry. */
  dataCategory: string;
  /** Source table/resource (e.g. 'reservations', 'persons', 'visitors'). */
  resourceType: string;
  /** What kind of access this represents — drives audit query filtering. */
  accessMethod: 'list_query' | 'detail_view' | 'export' | 'search' | 'api';

  /**
   * Resolve the resource id from the request. Default: try `params.id`.
   * Return null when the access doesn't have a single resource id (list).
   */
  resourceIdFromRequest?: (req: ExpressRequestLike) => string | null | undefined;

  /**
   * Resolve the subject person id (whose data is being accessed) from the
   * response or request. The interceptor will probe a few common shapes
   * automatically, but adapters can override here.
   */
  subjectPersonIdFromResult?: (result: unknown, req: ExpressRequestLike) => string | null | undefined;

  /** Resolve an actor role (admin / desk / etc.) from the request user. */
  actorRoleFromRequest?: (req: ExpressRequestLike) => string | null | undefined;
}

export interface ExpressRequestLike {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  user?: { id?: string };
}

export const LogPersonalDataAccess = (config: LogPersonalDataAccessConfig) =>
  SetMetadata(LOG_PII_ACCESS_METADATA, config);
