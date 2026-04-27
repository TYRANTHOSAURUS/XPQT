import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { TenantContext } from '../../common/tenant-context';
import {
  ExpressRequestLike,
  LOG_PII_ACCESS_METADATA,
  LogPersonalDataAccessConfig,
} from './log-personal-data-access.decorator';
import { PersonalDataAccessLogService } from './personal-data-access-log.service';

/**
 * Reads @LogPersonalDataAccess metadata, observes the response stream, and
 * enqueues an access-log entry per spec §7. Failures here MUST never break
 * the user's request — wrap everything in try/catch and log.
 */
@Injectable()
export class PersonalDataAccessInterceptor implements NestInterceptor {
  private readonly log = new Logger(PersonalDataAccessInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly pdal: PersonalDataAccessLogService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const config = this.reflector.get<LogPersonalDataAccessConfig | undefined>(
      LOG_PII_ACCESS_METADATA,
      ctx.getHandler(),
    );
    if (!config) return next.handle();

    const req: ExpressRequestLike = ctx.switchToHttp().getRequest();

    return next.handle().pipe(
      tap({
        next: (result) => this.captureAccess(config, req, result),
        // Skip on error — failed responses didn't actually return PII to
        // the actor, so no logging warranted.
      }),
    );
  }

  private captureAccess(
    config: LogPersonalDataAccessConfig,
    req: ExpressRequestLike,
    result: unknown,
  ): void {
    try {
      const tenant = TenantContext.currentOrNull();
      if (!tenant) return;

      const actorAuthUid = req.user?.id ?? null;
      const resourceId = config.resourceIdFromRequest
        ? config.resourceIdFromRequest(req) ?? null
        : (req.params?.id ?? null);

      const subjectPersonId = config.subjectPersonIdFromResult
        ? config.subjectPersonIdFromResult(result, req) ?? null
        : this.inferSubjectPersonId(result, resourceId);

      const ip = (req.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? null;
      const userAgent = (req.headers?.['user-agent'] as string | undefined) ?? null;
      const queryHash = this.pdal.hashQuery(req.query as Record<string, unknown> | undefined);

      this.pdal.enqueue({
        tenantId: tenant.id,
        actorAuthUid,
        actorRole: config.actorRoleFromRequest?.(req) ?? null,
        actorIpHash: this.pdal.hashIdentifier(ip ?? null, tenant.id),
        actorUserAgentHash: this.pdal.hashIdentifier(userAgent ?? null, tenant.id),
        subjectPersonId,
        dataCategory: config.dataCategory,
        resourceType: config.resourceType,
        resourceId,
        accessMethod: config.accessMethod,
        queryHash,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`access-log capture failed (silent): ${message}`);
    }
  }

  /**
   * Best-effort: when the resource itself looks like a person (resourceType
   * is 'persons' or the result has a `person_id` / `requester_person_id`),
   * pull it for the audit. This covers the common case without forcing
   * every controller to set `subjectPersonIdFromResult`.
   */
  private inferSubjectPersonId(result: unknown, resourceId: string | null): string | null {
    if (!result || typeof result !== 'object') return null;
    const obj = result as Record<string, unknown>;

    for (const key of ['person_id', 'requester_person_id', 'host_person_id', 'subject_person_id']) {
      const v = obj[key];
      if (typeof v === 'string') return v;
    }

    // If this is the persons endpoint, the resource id IS the subject.
    if (typeof obj.id === 'string' && resourceId === obj.id && obj.email !== undefined) {
      return resourceId;
    }
    return null;
  }
}
