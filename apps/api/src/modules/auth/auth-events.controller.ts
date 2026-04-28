import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from './public.decorator';
import { AuthEventsService, type SupabaseAuthEvent, type SupabaseAuthEventType } from './auth-events.service';

@Controller('webhooks/auth')
@Public()
export class AuthEventsController {
  constructor(
    private readonly events: AuthEventsService,
    private readonly config: ConfigService,
  ) {}

  @Post('sign-in')
  @HttpCode(204)
  async signInWebhook(
    @Headers('authorization') authorization: string,
    @Body() body: unknown,
  ): Promise<void> {
    this.verifySecret(authorization);
    const event = this.parsePayload(body);
    switch (event.type) {
      case 'sign_in':        await this.events.recordSignIn(event); return;
      case 'sign_out':       await this.events.recordSignOut(event); return;
      case 'sign_in_failed': await this.events.recordSignInFailed(event); return;
    }
  }

  private verifySecret(authorization: string): void {
    const expected = this.config.get<string>('SUPABASE_AUTH_HOOK_SECRET');
    if (!expected) {
      throw new UnauthorizedException('webhook secret not configured');
    }
    const provided = (authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!provided || provided !== expected) {
      throw new UnauthorizedException();
    }
  }

  /**
   * Translates the incoming payload into a normalized SupabaseAuthEvent.
   *
   * Currently assumes a pre-normalized shape `{ type, user_id, ... }`.
   * When Task 4 wires the actual Supabase Database Webhook envelope
   * (auth.audit_log_entries row), adapt ONLY this function — the rest of the
   * controller stays stable.
   */
  private parsePayload(body: unknown): SupabaseAuthEvent {
    if (!body || typeof body !== 'object') throw new BadRequestException('payload required');
    const b = body as Record<string, unknown>;
    const type = b.type as SupabaseAuthEventType;
    if (!['sign_in', 'sign_out', 'sign_in_failed'].includes(type)) {
      throw new BadRequestException(`unknown event type: ${String(b.type)}`);
    }
    if (typeof b.user_id !== 'string') throw new BadRequestException('user_id required');

    return {
      type,
      user_id: b.user_id,
      session_id: (b.session_id as string | null) ?? null,
      ip_address: (b.ip_address as string | null) ?? null,
      user_agent: (b.user_agent as string | null) ?? null,
      method: (b.method as string | null) ?? null,
      provider: (b.provider as string | null) ?? null,
      mfa_used: Boolean(b.mfa_used),
      occurred_at: (b.occurred_at as string) ?? new Date().toISOString(),
      failure_reason: (b.failure_reason as string | undefined) ?? undefined,
    };
  }
}
