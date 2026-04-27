import { Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toastError, toastRemoved } from '@/lib/toast';

interface Team { id: string; name: string; domain_scope: string | null; }

interface Props {
  teams: Team[];
  onChanged: () => void;
}

export function OrgNodeTeamsPanel({ teams, onChanged }: Props) {
  const detach = async (teamId: string) => {
    const restored = teams.find((t) => t.id === teamId);
    try {
      await apiFetch(`/teams/${teamId}`, {
        method: 'PATCH',
        body: JSON.stringify({ org_node_id: null }),
      });
      onChanged();
      toastRemoved(restored?.name ?? 'Team', {
        verb: 'detached',
        // We can't reattach without knowing the org node id this panel is for,
        // and the parent doesn't expose it. Detach skips Undo by design here.
      });
    } catch (err) {
      toastError("Couldn't detach team", { error: err, retry: () => detach(teamId) });
    }
  };

  if (teams.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No teams attached. Attach a team from the Teams admin page.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {teams.map((t) => (
        <li key={t.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
          <Wrench className="size-4 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{t.name}</div>
            {t.domain_scope && (
              <div className="text-xs text-muted-foreground truncate capitalize">{t.domain_scope}</div>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => detach(t.id)} aria-label="Detach team">
            <X className="size-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
