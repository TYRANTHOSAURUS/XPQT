import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export type ActivityItem =
  | { kind: 'ticket';  id: string; title: string; status: string; created_at: string }
  | { kind: 'booking'; id: string; space_name: string; starts_at: string; status: string; created_at: string }
  | { kind: 'audit';   id: string; event_type: string; details: unknown; actor_name: string | null; created_at: string };

@Injectable()
export class PersonActivityService {
  constructor(private readonly supabase: SupabaseService) {}

  async getRecentActivity(personId: string, limit = 20): Promise<ActivityItem[]> {
    const tenant = TenantContext.current();

    const [ticketsRes, bookingsRes, auditsRes] = await Promise.all([
      this.supabase.admin
        .from('tickets')
        .select('id, title, status, created_at')
        .eq('tenant_id', tenant.id)
        .eq('requester_person_id', personId)
        .order('created_at', { ascending: false })
        .limit(limit),
      this.supabase.admin
        .from('reservations')
        .select('id, status, starts_at, created_at, space:spaces(name)')
        .eq('tenant_id', tenant.id)
        .or(`requester_person_id.eq.${personId},host_person_id.eq.${personId}`)
        .order('created_at', { ascending: false })
        .limit(limit),
      this.supabase.admin
        .from('audit_events')
        .select('id, event_type, details, created_at, actor:users!actor_user_id(person:persons(first_name, last_name))')
        .eq('tenant_id', tenant.id)
        .eq('entity_type', 'persons')
        .eq('entity_id', personId)
        .order('created_at', { ascending: false })
        .limit(limit),
    ]);

    if (ticketsRes.error) throw ticketsRes.error;
    if (bookingsRes.error) throw bookingsRes.error;
    if (auditsRes.error) throw auditsRes.error;

    const items: ActivityItem[] = [
      ...(ticketsRes.data ?? []).map((t: any) => ({
        kind: 'ticket' as const,
        id: t.id, title: t.title, status: t.status, created_at: t.created_at,
      })),
      ...(bookingsRes.data ?? []).map((b: any) => ({
        kind: 'booking' as const,
        id: b.id,
        space_name: b.space?.name ?? '—',
        starts_at: b.starts_at,
        status: b.status,
        created_at: b.created_at,
      })),
      ...(auditsRes.data ?? []).map((a: any) => ({
        kind: 'audit' as const,
        id: a.id,
        event_type: a.event_type,
        details: a.details,
        actor_name: a.actor?.person
          ? `${a.actor.person.first_name} ${a.actor.person.last_name}`
          : null,
        created_at: a.created_at,
      })),
    ];

    items.sort((x, y) => y.created_at.localeCompare(x.created_at));
    return items.slice(0, limit);
  }
}
