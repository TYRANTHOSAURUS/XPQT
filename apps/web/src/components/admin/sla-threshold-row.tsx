import { PersonPicker } from '@/components/person-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Trash2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import type {
  EscalationThreshold,
  ThresholdAction,
  ThresholdTargetType,
  ThresholdTimerScope,
} from '@/api/sla-policies';

interface Team { id: string; name: string }

interface SlaThresholdRowProps {
  value: EscalationThreshold;
  onChange: (next: EscalationThreshold) => void;
  onRemove: () => void;
  index: number;
}

export function SlaThresholdRow({ value, onChange, onRemove, index }: SlaThresholdRowProps) {
  const { data: teams } = useApi<Team[]>('/teams', []);

  const patch = (partial: Partial<EscalationThreshold>) => onChange({ ...value, ...partial });

  const percentInvalid =
    !Number.isFinite(value.at_percent) || value.at_percent < 1 || value.at_percent > 200;
  const targetInvalid =
    value.target_type !== 'manager_of_requester' && !value.target_id;

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/40 px-3 py-2">
      <span className="text-xs text-muted-foreground self-center">At</span>

      <Input
        id={`esc-pct-${index}`}
        type="number"
        value={value.at_percent}
        onChange={(e) => patch({ at_percent: parseInt(e.target.value || '0', 10) })}
        className={`h-8 w-16 text-sm ${percentInvalid ? 'border-red-500' : ''}`}
        min={1}
        max={200}
      />
      <span className="text-xs text-muted-foreground self-center">% of</span>

      <Select value={value.timer_type} onValueChange={(v) => patch({ timer_type: (v ?? 'resolution') as ThresholdTimerScope })}>
        <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="response">Response</SelectItem>
          <SelectItem value="resolution">Resolution</SelectItem>
          <SelectItem value="both">Both</SelectItem>
        </SelectContent>
      </Select>

      <span className="text-xs text-muted-foreground self-center">&rarr;</span>

      <Select value={value.action} onValueChange={(v) => patch({ action: (v ?? 'notify') as ThresholdAction })}>
        <SelectTrigger className="h-8 w-36 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="notify">Notify</SelectItem>
          <SelectItem value="escalate">Escalate (reassign)</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={value.target_type}
        onValueChange={(v) => patch({
          target_type: (v ?? 'user') as ThresholdTargetType,
          target_id: null,
        })}
      >
        <SelectTrigger className="h-8 w-44 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="user">User</SelectItem>
          <SelectItem value="team">Team</SelectItem>
          <SelectItem value="manager_of_requester">Requester's manager</SelectItem>
        </SelectContent>
      </Select>

      {value.target_type === 'user' && (
        <div className={`flex-1 min-w-[220px] ${targetInvalid ? 'ring-1 ring-red-500 rounded-md' : ''}`}>
          <PersonPicker
            value={value.target_id ?? ''}
            onChange={(id) => patch({ target_id: id || null })}
            placeholder="Pick a user..."
          />
        </div>
      )}

      {value.target_type === 'team' && (
        <Select value={value.target_id ?? ''} onValueChange={(v) => patch({ target_id: v || null })}>
          <SelectTrigger className={`h-8 w-52 text-sm ${targetInvalid ? 'border-red-500' : ''}`}>
            <SelectValue placeholder="Pick a team..." />
          </SelectTrigger>
          <SelectContent>
            {(teams ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.target_type === 'manager_of_requester' && (
        <span className="text-xs text-muted-foreground self-center">
          Uses the requester's manager from their profile.
        </span>
      )}

      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function isThresholdValid(t: EscalationThreshold): boolean {
  if (!Number.isInteger(t.at_percent) || t.at_percent < 1 || t.at_percent > 200) return false;
  if (t.target_type === 'manager_of_requester') return true;
  return !!t.target_id;
}
