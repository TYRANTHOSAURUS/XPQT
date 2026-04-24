import { UserCircle, PencilLine, Trash2, Shield, Plus, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { RoleAuditEvent } from '@/api/roles';

interface RoleAuditFeedProps {
  events: RoleAuditEvent[] | undefined;
  loading: boolean;
  emptyLabel?: string;
  /**
   * When rendered on a role detail page, `hideTargetRole` suppresses the
   * redundant "on role X" chip since the parent page is already that role.
   * Same for a user detail page with `hideTargetUser`.
   */
  hideTargetRole?: boolean;
  hideTargetUser?: boolean;
}

export function RoleAuditFeed({
  events,
  loading,
  emptyLabel = 'No recent activity.',
  hideTargetRole,
  hideTargetUser,
}: RoleAuditFeedProps) {
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!events || events.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <ol className="flex flex-col">
      {events.map((ev, idx) => (
        <li
          key={ev.id}
          className={cn(
            'flex items-start gap-3 py-3',
            idx !== events.length - 1 && 'border-b',
          )}
        >
          <EventIcon type={ev.event_type} />
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span className="font-medium">{formatActor(ev)}</span>
              <span className="text-muted-foreground">
                {formatEventVerb(ev.event_type)}
              </span>
              {!hideTargetRole && ev.target_role_id && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Shield className="size-2.5" />
                  role
                </Badge>
              )}
              {!hideTargetUser && ev.target_user_id && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <UserCircle className="size-2.5" />
                  user
                </Badge>
              )}
            </div>
            <AuditPayload type={ev.event_type} payload={ev.payload} />
            <time className="text-[11px] text-muted-foreground">
              {formatTimestamp(ev.created_at)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

function EventIcon({ type }: { type: RoleAuditEvent['event_type'] }) {
  const cls = 'size-4 mt-0.5 shrink-0';
  switch (type) {
    case 'role.created':
    case 'assignment.created':
      return <Plus className={cn(cls, 'text-emerald-600')} />;
    case 'role.deleted':
    case 'assignment.revoked':
      return <Trash2 className={cn(cls, 'text-destructive')} />;
    case 'role.permissions_changed':
      return <ShieldAlert className={cn(cls, 'text-amber-600')} />;
    case 'role.updated':
    case 'assignment.updated':
    default:
      return <PencilLine className={cn(cls, 'text-muted-foreground')} />;
  }
}

function formatEventVerb(type: RoleAuditEvent['event_type']): string {
  switch (type) {
    case 'role.created':
      return 'created a role';
    case 'role.updated':
      return 'updated a role';
    case 'role.deleted':
      return 'deleted a role';
    case 'role.permissions_changed':
      return 'changed role permissions';
    case 'assignment.created':
      return 'assigned a role';
    case 'assignment.updated':
      return 'updated an assignment';
    case 'assignment.revoked':
      return 'revoked an assignment';
    default:
      return type;
  }
}

function formatActor(ev: RoleAuditEvent): string {
  const a = ev.actor;
  if (!a) return 'System';
  if (a.person) return `${a.person.first_name} ${a.person.last_name}`;
  return a.email ?? 'Unknown';
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function AuditPayload({
  type,
  payload,
}: {
  type: RoleAuditEvent['event_type'];
  payload: Record<string, unknown>;
}) {
  if (type === 'role.permissions_changed') {
    const before = asStringArray(payload.previous_permissions);
    const after = asStringArray(payload.next_permissions);
    const added = after.filter((p) => !before.includes(p));
    const removed = before.filter((p) => !after.includes(p));
    if (added.length === 0 && removed.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {added.map((p) => (
          <code
            key={`a-${p}`}
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5"
          >
            + {p}
          </code>
        ))}
        {removed.map((p) => (
          <code
            key={`r-${p}`}
            className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5"
          >
            − {p}
          </code>
        ))}
      </div>
    );
  }

  if (type === 'assignment.created' || type === 'assignment.revoked') {
    const domain = asStringArray(payload.domain_scope);
    const location = asStringArray(payload.location_scope);
    const startsAt = typeof payload.starts_at === 'string' ? payload.starts_at : null;
    const endsAt = typeof payload.ends_at === 'string' ? payload.ends_at : null;
    const chips: string[] = [];
    if (domain.length > 0) chips.push(`domain: ${domain.join(', ')}`);
    if (location.length > 0)
      chips.push(`${location.length} location${location.length === 1 ? '' : 's'}`);
    if (startsAt) chips.push(`starts ${formatTimestamp(startsAt)}`);
    if (endsAt) chips.push(`ends ${formatTimestamp(endsAt)}`);
    if (chips.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        {chips.map((c, i) => (
          <span key={i} className="rounded border px-1.5 py-0.5">
            {c}
          </span>
        ))}
      </div>
    );
  }

  if (type === 'role.created') {
    const perms = asStringArray(payload.permissions);
    if (perms.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1">
        {perms.slice(0, 8).map((p) => (
          <code
            key={p}
            className="text-[10px] rounded border px-1.5 py-0.5 bg-muted/50"
          >
            {p}
          </code>
        ))}
        {perms.length > 8 && (
          <span className="text-[10px] text-muted-foreground">
            +{perms.length - 8} more
          </span>
        )}
      </div>
    );
  }

  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
