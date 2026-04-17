import type { WorkflowNode } from '../types';

export function TriggerForm(_: { node: WorkflowNode; readOnly: boolean }) {
  return <p className="text-xs text-muted-foreground">The trigger marks where the workflow starts. No additional config.</p>;
}
