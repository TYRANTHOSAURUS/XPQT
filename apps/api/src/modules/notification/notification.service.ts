import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

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

    if (error) throw error;

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

  /**
   * Get in-app notifications for a person.
   */
  async getInAppForPerson(personId: string, unreadOnly = false) {
    const tenant = TenantContext.current();

    let query = this.supabase.admin
      .from('notifications')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('recipient_person_id', personId)
      .eq('target_channel', 'in_app')
      .order('created_at', { ascending: false })
      .limit(50);

    if (unreadOnly) {
      query = query.is('read_at', null);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  /**
   * Mark a notification as read.
   */
  async markAsRead(notificationId: string) {
    const { error } = await this.supabase.admin
      .from('notifications')
      .update({ status: 'read', read_at: new Date().toISOString() })
      .eq('id', notificationId);

    if (error) throw error;
    return { read: true };
  }

  /**
   * Mark all in-app notifications as read for a person.
   */
  async markAllAsRead(personId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('notifications')
      .update({ status: 'read', read_at: new Date().toISOString() })
      .eq('tenant_id', tenant.id)
      .eq('recipient_person_id', personId)
      .eq('target_channel', 'in_app')
      .is('read_at', null);

    if (error) throw error;
    return { read_all: true };
  }

  /**
   * Get unread notification count for a person.
   */
  async getUnreadCount(personId: string) {
    const tenant = TenantContext.current();
    const { count, error } = await this.supabase.admin
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('recipient_person_id', personId)
      .eq('target_channel', 'in_app')
      .is('read_at', null);

    if (error) throw error;
    return { unread_count: count ?? 0 };
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
      .eq('event_type', eventType)
      .single();

    if (!pref) return requestedChannels; // No preference = use defaults

    return requestedChannels.filter((ch) => {
      if (ch === 'email') return pref.email_enabled;
      if (ch === 'in_app') return pref.in_app_enabled;
      return true;
    });
  }
}
