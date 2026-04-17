export type NodeType =
  | 'trigger' | 'end' | 'assign' | 'approval' | 'notification'
  | 'condition' | 'update_ticket' | 'create_child_tasks' | 'wait_for' | 'timer'
  | 'http_request';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  entity_type: string;
  version: number;
  status: 'draft' | 'published';
  graph_definition: WorkflowGraph;
  created_at: string;
  published_at: string | null;
}

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}
