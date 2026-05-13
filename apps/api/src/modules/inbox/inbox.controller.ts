import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppErrors } from '../../common/errors';
import { InboxService } from './inbox.service';
import type {
  InboxCountResponse,
  InboxListResponse,
} from './dto/inbox-list.dto';
import type {
  InboxMarkAllReadResponse,
  InboxMarkReadResponse,
} from './dto/inbox-mark-read.dto';

/**
 * Inbox HTTP surface — `/me/inbox` per-user notification feed.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step E.
 *
 * No additional `@UseGuards()` here — the global `AuthGuard` (registered
 * via APP_GUARD in app.module.ts) already requires a valid Supabase Bearer
 * token on every route. The inbox is per-user; the actor is resolved from
 * `req.user.id` via `InboxService.resolveActor()` (auth_uid → users.id
 * bridge) on every handler. Permission gating is intentionally absent
 * (architect C1 + plan-review I2) — every authenticated user reads their
 * own inbox, RLS provides defense-in-depth on the table.
 *
 * Routes:
 *   - GET  /me/inbox?cursor=…&limit=…  — paginated list
 *   - GET  /me/inbox/count             — { unread, total }
 *   - POST /me/inbox/:id/read          — idempotent single-row mark
 *   - POST /me/inbox/read-all          — bulk mark, returns { marked }
 *
 * Citations:
 *   - apps/api/src/modules/calendar-sync/calendar-sync.controller.ts:20-24
 *       canonical `private authUid()` helper that throws unauthorized
 *       when `req.user.id` is missing.
 *   - apps/api/src/app.module.ts:113-116
 *       global APP_GUARD AuthGuard — every controller is auth-gated by default.
 */
@Controller('me/inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  async list(
    @Req() request: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<InboxListResponse> {
    const actor = await this.inbox.resolveActor(this.authUid(request));
    return this.inbox.list(actor, {
      cursor: cursor && cursor.length > 0 ? cursor : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Get('count')
  async count(@Req() request: Request): Promise<InboxCountResponse> {
    const actor = await this.inbox.resolveActor(this.authUid(request));
    return this.inbox.count(actor);
  }

  /**
   * Sub-step F's React Query hook calls this with a path segment ordering
   * `/me/inbox/:id/read` (POST). NestJS routes this method ahead of any
   * conflicting `:id` GET because we explicitly nest `:id/read`.
   */
  @Post(':id/read')
  async markRead(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<InboxMarkReadResponse> {
    const actor = await this.inbox.resolveActor(this.authUid(request));
    return this.inbox.markRead(actor, id);
  }

  @Post('read-all')
  async markAllRead(@Req() request: Request): Promise<InboxMarkAllReadResponse> {
    const actor = await this.inbox.resolveActor(this.authUid(request));
    return this.inbox.markAllRead(actor);
  }

  private authUid(request: Request): string {
    const authUid = (request as { user?: { id: string } }).user?.id;
    if (!authUid) {
      throw AppErrors.unauthorized('No auth user');
    }
    return authUid;
  }
}
