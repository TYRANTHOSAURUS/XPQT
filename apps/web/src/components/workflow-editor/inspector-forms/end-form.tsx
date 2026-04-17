import type { WorkflowNode } from '../types';

export function EndForm(_: { node: WorkflowNode; readOnly: boolean }) {
  return <p className="text-xs text-muted-foreground">When the workflow reaches this node, it completes.</p>;
}
