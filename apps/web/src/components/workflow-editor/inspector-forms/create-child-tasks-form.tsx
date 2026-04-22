import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field, FieldGroup, FieldLabel, FieldLegend, FieldSet,
} from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2 } from 'lucide-react';

interface Task {
  title: string;
  description?: string;
  priority?: string;
  assigned_team_id?: string;
  sla_policy_id?: string | null;
}

interface Team { id: string; name: string }
interface SlaPolicy { id: string; name: string }

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const SLA_INHERIT = '';
const SLA_NONE = '__none__';

export function CreateChildTasksForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const tasks = ((node.config as { tasks?: Task[] }).tasks ?? []) as Task[];
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: slaPolicies } = useApi<SlaPolicy[]>('/sla-policies', []);

  const setTasks = (t: Task[]) => update(node.id, { tasks: t });
  const patchTask = (i: number, patch: Partial<Task>) =>
    setTasks(tasks.map((x, j) => j === i ? { ...x, ...patch } : x));

  const slaValueFor = (t: Task): string => {
    if (t.sla_policy_id === undefined) return SLA_INHERIT;
    if (t.sla_policy_id === null) return SLA_NONE;
    return t.sla_policy_id;
  };
  const onSlaChange = (i: number, v: string) => {
    if (v === SLA_INHERIT) {
      const { sla_policy_id, ...rest } = tasks[i];
      void sla_policy_id;
      setTasks(tasks.map((x, j) => j === i ? rest : x));
    } else if (v === SLA_NONE) {
      patchTask(i, { sla_policy_id: null });
    } else {
      patchTask(i, { sla_policy_id: v });
    }
  };

  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label" className="text-xs">Child tasks</FieldLegend>
        {tasks.map((t, i) => (
          <div key={i} className="grid gap-2 border rounded p-2">
            <Field>
              <FieldLabel htmlFor={`task-${i}-title`}>Title</FieldLabel>
              <Input
                id={`task-${i}-title`}
                value={t.title ?? ''}
                placeholder="Title"
                onChange={(e) => patchTask(i, { title: e.target.value })}
                disabled={readOnly}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-desc`}>Description</FieldLabel>
              <Input
                id={`task-${i}-desc`}
                value={t.description ?? ''}
                placeholder="Description (optional)"
                onChange={(e) => patchTask(i, { description: e.target.value })}
                disabled={readOnly}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-team`}>Assigned team</FieldLabel>
              <Select
                value={t.assigned_team_id ?? ''}
                onValueChange={(v) => patchTask(i, { assigned_team_id: v || undefined })}
                disabled={readOnly}
              >
                <SelectTrigger id={`task-${i}-team`}><SelectValue placeholder="Resolver decides" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Resolver decides</SelectItem>
                  {(teams ?? []).map((tm) => (
                    <SelectItem key={tm.id} value={tm.id}>{tm.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-prio`}>Priority</FieldLabel>
              <Select
                value={t.priority ?? ''}
                onValueChange={(v) => patchTask(i, { priority: v || undefined })}
                disabled={readOnly}
              >
                <SelectTrigger id={`task-${i}-prio`}><SelectValue placeholder="Inherit from parent" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Inherit from parent</SelectItem>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-sla`}>SLA policy</FieldLabel>
              <Select
                value={slaValueFor(t)}
                onValueChange={(v) => onSlaChange(i, v ?? SLA_INHERIT)}
                disabled={readOnly}
              >
                <SelectTrigger id={`task-${i}-sla`}><SelectValue placeholder="Inherit from default" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={SLA_INHERIT}>Inherit from default</SelectItem>
                  <SelectItem value={SLA_NONE}>No SLA</SelectItem>
                  {(slaPolicies ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
              disabled={readOnly}
              className="gap-1 w-fit"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTasks([...tasks, { title: '' }])}
          disabled={readOnly}
          className="gap-1 w-fit"
        >
          <Plus className="h-3.5 w-3.5" /> Add task
        </Button>
      </FieldSet>
    </FieldGroup>
  );
}
