import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { wrapPgError } from '../../common/errors';

export interface CreateNotificationTemplateDto {
  name: string;
  event_type: string;
  subject: string;
  body: string;
  channels: ('email' | 'in_app')[];
}

export interface SendNotificationDto {
  notification_type: string; // e.g. 'ticket_assigned', 'approval_requested'
  recipient_person_id?: string;
  recipient_team_id?: string;
  related_entity_type?: string;
  related_entity_id?: string;
  subject: string;
  body: string;
  channels?: ('email' | 'in_app')[];
}

@Injectable()
export class NotificationService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Send a notification to a person or team.
   * Creates notification records for each channel (email + in-app).
   * Respects user notification preferences.
   */
  async send(dto: SendNotificationDto) {
    const tenant = TenantContext.current();
    const channels = dto.channels ?? ['email', 'in_app'];

    // Check user preferences if sending to a specific person
    let enabledChannels = channels;
    if (dto.recipient_person_id) {
      enabledChannels = await this.getEnabledChannels(
        dto.recipient_person_id,
        dto.notification_type,
        channels,
      );
    }

    const notifications = enabledChannels.map((channel) => ({
      tenant_id: tenant.id,
      notification_type: dto.notification_type,
      target_channel: channel,
      recipient_person_id: dto.recipient_person_id,
      recipient_team_id: dto.recipient_team_id,
      related_entity_type: dto.related_entity_type,
      related_entity_id: dto.related_entity_id,
      subject: dto.subject,
      body: dto.body,
      status: 'pending',
    }));

    if (notifications.length === 0) return [];

    const { data, error } = await this.supabase.admin
      .from('notifications')
      .insert(notifications)
      .select();

    if (error) {
      throw wrapPgError(error, 'notification.send_failed', {
        detail: 'Notification insert failed',
      });
    }

    // Process pending notifications (email delivery happens here)
    // For now, mark email notifications as sent immediately
    // In production, this would queue to an email service (Resend, SES, etc.)
    for (const notification of data ?? []) {
      if (notification.target_channel === 'email') {
        await this.supabase.admin
          .from('notifications')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', notification.id);
      }
    }

    return data;
  }

  /**
   * Send notification to all members of a team.
   */
  async sendToTeam(teamId: string, dto: Omit<SendNotificationDto, 'recipient_person_id' | 'recipient_team_id'>) {
    const tenant = TenantContext.current();

    // Get team members
    const { data: members } = await this.supabase.admin
      .from('team_members')
      .select('user_id, user:users(person_id)')
      .eq('team_id', teamId)
      .eq('tenant_id', tenant.id);

    const results = [];
    for (const member of members ?? []) {
      const userRecord = member.user as unknown as { person_id: string } | null;
      const personId = userRecord?.person_id;
      if (personId) {
        const result = await this.send({
          ...dto,
          recipient_person_id: personId,
          recipient_team_id: teamId,
        });
        results.push(...result);
      }
    }

    return results;
  }

  // The per-person in-app *consumer* surface (list / unread-count /
  // mark-read / mark-all-read) lived here behind caller-supplied
  // id/personId with no recipient binding — a same-tenant IDOR
  // (docs/follow-ups/audits/04-rls-security.md, codex 2026-05-18 #1).
  // It had zero callers; the live inbox is the auth-bound, server-derived
  // `/me/inbox/*` (InboxService/InboxController, B.4.A.5). The dead
  // methods + routes were deleted. This class is now producer-only
  // (`send` / `sendToTeam`) plus the tenant-wide notification TEMPLATE
  // admin surface.

  // ─── Notification Templates ───────────────────────────────────────────────

  async listTemplates() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('config_entities')
      .select('*, current_version:config_versions!fk_ce_published_version(*)')
      .eq('tenant_id', tenant.id)
      .eq('config_type', 'notification_template')
      .order('display_name');
    if (error) {
      throw wrapPgError(error, 'notification.template_list_failed', {
        detail: 'Notification template list query failed',
      });
    }
    return data;
  }

  async createTemplate(dto: CreateNotificationTemplateDto) {
    const tenant = TenantContext.current();
    const slug = dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    const { data: entity, error: entityError } = await this.supabase.admin
      .from('config_entities')
      .insert({
        tenant_id: tenant.id,
        config_type: 'notification_template',
        slug,
        display_name: dto.name,
      })
      .select()
      .single();
    if (entityError) {
      throw wrapPgError(entityError, 'notification.template_create_failed', {
        detail: 'Notification template config_entities insert failed',
      });
    }

    const { data: version, error: versionError } = await this.supabase.admin
      .from('config_versions')
      .insert({
        config_entity_id: entity.id,
        tenant_id: tenant.id,
        version_number: 1,
        status: 'published',
        definition: {
          event_type: dto.event_type,
          subject: dto.subject,
          body: dto.body,
          channels: dto.channels,
        },
        published_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (versionError) {
      throw wrapPgError(versionError, 'notification.template_create_failed', {
        detail: 'Notification template config_versions insert failed',
      });
    }

    // Cross-tenant write fix (codex post-fix review 2026-05-08): write the
    // current_published_version_id with explicit tenant filter. The id was
    // just inserted by us above so it's safe per-row, but supabase.admin
    // bypasses RLS — defense-in-depth.
    await this.supabase.admin
      .from('config_entities')
      .update({ current_published_version_id: version.id })
      .eq('id', entity.id)
      .eq('tenant_id', tenant.id);

    return { ...entity, current_version: version };
  }

  async updateTemplate(id: string, dto: Partial<CreateNotificationTemplateDto>) {
    const tenant = TenantContext.current();

    if (dto.name) {
      await this.supabase.admin
        .from('config_entities')
        .update({ display_name: dto.name })
        .eq('id', id)
        .eq('tenant_id', tenant.id);
    }

    const { data: latest } = await this.supabase.admin
      .from('config_versions')
      .select('*')
      .eq('config_entity_id', id)
      .eq('tenant_id', tenant.id)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    const currentDef = (latest?.definition as Record<string, unknown>) ?? {};
    const newDef = {
      ...currentDef,
      ...(dto.event_type !== undefined && { event_type: dto.event_type }),
      ...(dto.subject !== undefined && { subject: dto.subject }),
      ...(dto.body !== undefined && { body: dto.body }),
      ...(dto.channels !== undefined && { channels: dto.channels }),
    };

    const nextVersion = (latest?.version_number ?? 0) + 1;
    const { data: version, error } = await this.supabase.admin
      .from('config_versions')
      .insert({
        config_entity_id: id,
        tenant_id: tenant.id,
        version_number: nextVersion,
        status: 'published',
        definition: newDef,
        published_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) {
      throw wrapPgError(error, 'notification.template_update_failed', {
        detail: `Notification template config_versions insert failed for entity ${id}`,
        notFoundCode: 'notification.not_found',
      });
    }

    // Cross-tenant write fix: tenant_id is in scope from the rename branch
    // above (or just defensively re-read). Filter explicitly.
    await this.supabase.admin
      .from('config_entities')
      .update({ current_published_version_id: version.id })
      .eq('id', id)
      .eq('tenant_id', tenant.id);

    return version;
  }

  private async getEnabledChannels(
    personId: string,
    eventType: string,
    requestedChannels: ('email' | 'in_app')[],
  ): Promise<('email' | 'in_app')[]> {
    // Look up the user by person_id to get user_id for preferences
    const tenant = TenantContext.current();
    const { data: user } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .limit(1)
      .single();

    if (!user) return requestedChannels; // No user record = use defaults

    const { data: pref } = await this.supabase.admin
      .from('notification_preferences')
      .select('*')
      .eq('user_id', user.id)
      .eq('tenant_id', tenant.id)
      .eq('event_type', eventType)
      .maybeSingle();

    if (!pref) return requestedChannels; // No preference = use defaults

    return requestedChannels.filter((ch) => {
      if (ch === 'email') return pref.email_enabled;
      if (ch === 'in_app') return pref.in_app_enabled;
      return true;
    });
  }
}
