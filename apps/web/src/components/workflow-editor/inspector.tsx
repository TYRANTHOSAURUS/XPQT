import { useGraphStore } from './graph-store';
import type { WorkflowNode } from './types';
import { NODE_TYPES } from './node-types';
import { TriggerForm } from './inspector-forms/trigger-form';
import { EndForm } from './inspector-forms/end-form';
import { AssignForm } from './inspector-forms/assign-form';
import { ApprovalForm } from './inspector-forms/approval-form';
import { NotificationForm } from './inspector-forms/notification-form';
import { ConditionForm } from './inspector-forms/condition-form';
import { UpdateTicketForm } from './inspector-forms/update-ticket-form';
import { CreateChildTasksForm } from './inspector-forms/create-child-tasks-form';
import { WaitForForm } from './inspector-forms/wait-for-form';
import { TimerForm } from './inspector-forms/timer-form';
import { HttpRequestForm } from './inspector-forms/http-request-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Inspector({ readOnly = false }: { readOnly?: boolean }) {
  const selectedIds = useGraphStore((s) => s.selectedIds);
  const nodes = useGraphStore((s) => s.nodes);
  const renameNode = useGraphStore((s) => s.renameNode);

  const selected: WorkflowNode | null = selectedIds.length === 1
    ? nodes.find((n) => n.id === selectedIds[0]) ?? null
    : null;

  if (!selected) {
    return (
      <aside className="w-[300px] border-l bg-muted/30 p-4 overflow-auto shrink-0">
        <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Inspector</div>
        <p className="text-sm text-muted-foreground">
          {selectedIds.length > 1 ? `${selectedIds.length} nodes selected` : 'Select a node to edit its configuration.'}
        </p>
      </aside>
    );
  }

  const meta = NODE_TYPES[selected.type];
  const Icon = meta.icon;

  return (
    <aside className="w-[300px] border-l bg-muted/30 p-4 overflow-auto shrink-0">
      <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Inspector</div>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4" />
        <div className="font-semibold">{meta.label}</div>
      </div>

      <div className="grid gap-1.5 mb-3">
        <Label className="text-xs">Label (optional)</Label>
        <Input
          value={(selected.config.label as string) ?? ''}
          onChange={(e) => renameNode(selected.id, e.target.value)}
          placeholder={meta.label}
          disabled={readOnly}
        />
      </div>

      <FormFor node={selected} readOnly={readOnly} />
    </aside>
  );
}

function FormFor({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  switch (node.type) {
    case 'trigger': return <TriggerForm node={node} readOnly={readOnly} />;
    case 'end': return <EndForm node={node} readOnly={readOnly} />;
    case 'assign': return <AssignForm node={node} readOnly={readOnly} />;
    case 'approval': return <ApprovalForm node={node} readOnly={readOnly} />;
    case 'notification': return <NotificationForm node={node} readOnly={readOnly} />;
    case 'condition': return <ConditionForm node={node} readOnly={readOnly} />;
    case 'update_ticket': return <UpdateTicketForm node={node} readOnly={readOnly} />;
    case 'create_child_tasks': return <CreateChildTasksForm node={node} readOnly={readOnly} />;
    case 'wait_for': return <WaitForForm node={node} readOnly={readOnly} />;
    case 'timer': return <TimerForm node={node} readOnly={readOnly} />;
    case 'http_request': return <HttpRequestForm node={node} readOnly={readOnly} />;
  }
}
