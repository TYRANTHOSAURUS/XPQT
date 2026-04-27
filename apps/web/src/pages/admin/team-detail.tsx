import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toastError, toastRemoved } from '@/lib/toast';
import { Trash2 } from 'lucide-react';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useTeam,
  useTeamMembers,
  useUpsertTeam,
  useDeleteTeam,
} from '@/api/teams';
import { useDebouncedSave } from '@/hooks/use-debounced-save';

export function TeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: team, isLoading } = useTeam(id);
  const { data: members } = useTeamMembers(id);
  const upsert = useUpsertTeam();
  const del = useDeleteTeam();

  const [name, setName] = useState('');
  const [domainScope, setDomainScope] = useState('');
  const [active, setActive] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const teamId = team?.id;
  useEffect(() => {
    if (!team) return;
    setName(team.name ?? '');
    setDomainScope(team.domain_scope ?? '');
    setActive(team.active ?? true);
  }, [teamId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (upsert.error) {
      toastError("Couldn't save team", { error: upsert.error });
    }
  }, [upsert.error]);

  useDebouncedSave(name, (v) => {
    if (!team || v === team.name) return;
    upsert.mutate({ id: team.id, payload: { name: v } });
  });
  useDebouncedSave(domainScope, (v) => {
    if (!team || v === (team.domain_scope ?? '')) return;
    upsert.mutate({ id: team.id, payload: { name: team.name, domain_scope: v || null } });
  });

  const headline = useMemo(() => team?.name ?? 'Loading…', [team]);
  const memberCount = members?.length ?? 0;

  if (!id) return null;

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader backTo="/admin/teams" title="Loading…" description="Fetching team details" />
      </SettingsPageShell>
    );
  }

  if (!team) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/teams"
          title="Not found"
          description={`No team with id ${id} in this tenant.`}
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/teams"
        title={headline}
        description="Service-desk team that owns work."
        actions={
          <Badge variant={active ? 'default' : 'outline'} className="text-[10px] uppercase tracking-wider">
            {active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />

      <SettingsGroup title="Identity" description="Team name and routing scope.">
        <SettingsRow label="Name">
          <SettingsRowValue>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 w-72"
              aria-label="Team name"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow
          label="Domain scope"
          description="Single domain identifier (e.g. fm, it, security). Empty = cross-domain."
        >
          <SettingsRowValue>
            <Input
              value={domainScope}
              onChange={(e) => setDomainScope(e.target.value)}
              className="h-8 w-56"
              aria-label="Domain scope"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Active">
          <SettingsRowValue>
            <Switch
              checked={active}
              onCheckedChange={(v) => {
                setActive(v);
                upsert.mutate({ id: team.id, payload: { name: team.name, active: v } });
              }}
              aria-label="Active"
            />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Members"
        description={memberCount === 1 ? '1 member' : `${memberCount} members`}
      >
        {memberCount === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No members yet. Add operators from the team management UI.
          </div>
        ) : (
          <div className="divide-y">
            {(members ?? []).map((m) => {
              const fullName = m.user?.person
                ? `${m.user.person.first_name} ${m.user.person.last_name}`.trim()
                : null;
              return (
                <div key={m.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <div className="flex flex-col">
                    <span>{fullName ?? m.user?.email ?? 'Unknown user'}</span>
                    {fullName && m.user?.email && (
                      <span className="text-xs text-muted-foreground">{m.user.email}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Delete team"
          description="Tickets currently owned by this team need to be reassigned first."
        >
          <SettingsRowValue>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${headline}?`}
        description="This cannot be undone. Tickets that referenced this team keep their historical link but will no longer route here."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await del.mutateAsync(team.id);
          toastRemoved(headline, { verb: 'deleted' });
          setConfirmDelete(false);
          navigate('/admin/teams');
        }}
      />
    </SettingsPageShell>
  );
}
