import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

export type SupabaseAuthEventType = 'sign_in' | 'sign_out' | 'sign_in_failed';

export interface SupabaseAuthEvent {
  type: SupabaseAuthEventType;
  user_id: string;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  method: string | null;
  provider: string | null;
  mfa_used: boolean;
  occurred_at: string;
  failure_reason?: string;
}

@Injectable()
export class AuthEventsService {
  private readonly log = new Logger(AuthEventsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async recordSignIn(event: SupabaseAuthEvent): Promise<void> {
    await this.insertEvent(event, 'sign_in', { success: true });
    await this.touchLastLogin(event.user_id, event.occurred_at);
  }

  async recordSignOut(event: SupabaseAuthEvent): Promise<void> {
    await this.insertEvent(event, 'sign_out', { success: true });
  }

  async recordSignInFailed(event: SupabaseAuthEvent): Promise<void> {
    await this.insertEvent(event, 'sign_in_failed', {
      success: false,
      failure_reason: event.failure_reason ?? null,
    });
  }

  private async insertEvent(
    event: SupabaseAuthEvent,
    kind: SupabaseAuthEventType,
    extra: { success: boolean; failure_reason?: string | null },
  ): Promise<void> {
    const tenantId = await this.resolveTenantId(event.user_id);

    const row = {
      tenant_id: tenantId,
      user_id: event.user_id,
      event_kind: kind,
      signed_in_at: event.occurred_at,
      session_id: event.session_id,
      ip_address: event.ip_address,
      user_agent: event.user_agent,
      method: event.method,
      provider: event.provider,
      mfa_used: event.mfa_used,
      success: extra.success,
      failure_reason: extra.failure_reason ?? null,
    };

    const { error } = await this.supabase.admin
      .from('auth_sign_in_events')
      .insert(row)
      .select()
      .maybeSingle();

    if (!error) return;

    if ((error as { code?: string }).code === '23505') {
      this.log.debug(`Duplicate ${kind} for session ${event.session_id} — ignored`);
      return;
    }
    throw error;
  }

  private async touchLastLogin(userId: string, occurredAt: string): Promise<void> {
    await this.supabase.admin
      .from('users')
      .update({ last_login_at: occurredAt })
      .eq('id', userId)
      .select()
      .maybeSingle();
  }

  private async resolveTenantId(userId: string): Promise<string> {
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('tenant_id')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new BadRequestException(`unknown user: ${userId}`);
    return (data as { tenant_id: string }).tenant_id;
  }
}
