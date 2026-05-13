import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppErrors } from '../../common/errors';
import { PermissionGuard } from '../../common/permission-guard';
import {
  NotificationTemplateService,
  type TemplateLocale,
  type TemplateOverrideRow,
  type TemplateOverrideUpsert,
} from './template-overrides.service';

/**
 * Admin HTTP surface — `/admin/notification-templates`.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G.
 *
 * Routes:
 *   - GET  /admin/notification-templates
 *       List the per-locale override rows for the current tenant. Powers
 *       the admin index page's Default / Customized status badges. The
 *       set of "known" event_kinds itself is sourced from the frontend's
 *       static registry (sub-step F's templates/types.ts) — the API is
 *       intentionally narrow so adding a new kind is a one-touch
 *       frontend change once the new template module ships.
 *
 *   - GET  /admin/notification-templates/:eventKind
 *       Return the EN + NL rows for a single event_kind. Always emits
 *       both keys (null when the row doesn't exist yet) so the editor can
 *       render its EN / NL tabs without an extra round-trip.
 *
 *   - PUT  /admin/notification-templates/:eventKind
 *       Body: `{ locale: 'en'|'nl', subject_override?, cta_text_override?,
 *       body_intro_override? }`. Upserts the row; empty / whitespace-only
 *       fields normalize to null so the renderer's defaults take over
 *       (architect I5). Emits one audit_event per write.
 *
 * Permission gating:
 *   - All three routes require `notifications.manage_templates` (canonical
 *     key registered in `packages/shared/src/permissions.ts:381`). Read +
 *     write share the same gate — there's no use case for "see overrides
 *     but can't edit"; the customisation surface is admin-only end-to-end.
 *
 * Auth:
 *   - The global `AuthGuard` (registered via APP_GUARD in app.module.ts)
 *     already requires a valid Supabase Bearer token on every route.
 *   - `PermissionGuard.requirePermission(req, 'notifications.manage_templates')`
 *     bridges `req.user.id` (auth_uid) → `users.id` then calls
 *     `user_has_permission(p_user_id, p_tenant_id, p_permission)`. Returns
 *     the resolved `userId` for downstream audit-attribution.
 *
 * Citations:
 *   - apps/api/src/modules/daily-list/daily-list-admin.controller.ts:31-191
 *       canonical PermissionGuard call shape (this controller mirrors it).
 *   - apps/api/src/common/permission-guard.ts:24-50
 *       guard implementation — also rejects with permission_denied(key).
 */
@Controller('admin/notification-templates')
export class NotificationTemplatesController {
  constructor(
    private readonly service: NotificationTemplateService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() req: Request): Promise<TemplateOverrideRow[]> {
    await this.permissions.requirePermission(req, 'notifications.manage_templates');
    return this.service.list();
  }

  @Get(':eventKind')
  async getOne(
    @Req() req: Request,
    @Param('eventKind') eventKind: string,
  ): Promise<{
    eventKind: string;
    en: TemplateOverrideRow | null;
    nl: TemplateOverrideRow | null;
  }> {
    await this.permissions.requirePermission(req, 'notifications.manage_templates');
    return this.service.getByEventKind(eventKind);
  }

  @Put(':eventKind')
  async upsert(
    @Req() req: Request,
    @Param('eventKind') eventKind: string,
    @Body() body: UpsertBody,
  ): Promise<TemplateOverrideRow> {
    const { userId } = await this.permissions.requirePermission(
      req,
      'notifications.manage_templates',
    );
    assertUpsertBody(body);
    return this.service.upsert(
      eventKind,
      body.locale,
      {
        subject_override: body.subject_override,
        cta_text_override: body.cta_text_override,
        body_intro_override: body.body_intro_override,
      },
      { userId },
    );
  }
}

interface UpsertBody {
  locale: TemplateLocale;
  subject_override?: string | null;
  cta_text_override?: string | null;
  body_intro_override?: string | null;
}

/**
 * Reject malformed bodies before they reach the service. The service
 * re-validates `locale` (defense in depth) but the early throw keeps the
 * 4xx surface clean.
 */
function assertUpsertBody(body: UpsertBody | null | undefined): asserts body is UpsertBody {
  if (!body || typeof body !== 'object') {
    throw AppErrors.validationFailed('generic.bad_request', { detail: 'Body required' });
  }
  if (body.locale !== 'en' && body.locale !== 'nl') {
    throw AppErrors.validationFailed('generic.bad_request', {
      detail: "locale must be 'en' or 'nl'",
    });
  }
  // Override fields are typed as optional. A missing key is fine; a present
  // non-string non-null value is rejected so we never store garbage.
  for (const key of ['subject_override', 'cta_text_override', 'body_intro_override'] as const) {
    const v = body[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      throw AppErrors.validationFailed('generic.bad_request', {
        detail: `${key} must be a string or null`,
      });
    }
  }
}
