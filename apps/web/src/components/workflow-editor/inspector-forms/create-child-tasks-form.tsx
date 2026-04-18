import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  FieldGroup,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Plus, Trash2 } from 'lucide-react';

interface Task { title: string; description?: string; priority?: string }

export function CreateChildTasksForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const tasks = ((node.config as { tasks?: Task[] }).tasks ?? []) as Task[];

  const setTasks = (t: Task[]) => update(node.id, { tasks: t });

  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label" className="text-xs">Child tasks</FieldLegend>
        {tasks.map((t, i) => (
          <div key={i} className="grid gap-1 border rounded p-2">
            <Input
              value={t.title ?? ''}
              placeholder="Title"
              onChange={(e) => setTasks(tasks.map((x, j) => j === i ? { ...x, title: e.target.value } : x))}
              disabled={readOnly}
            />
            <Input
              value={t.description ?? ''}
              placeholder="Description (optional)"
              onChange={(e) => setTasks(tasks.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
              disabled={readOnly}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
              disabled={readOnly}
              className="gap-1"
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
