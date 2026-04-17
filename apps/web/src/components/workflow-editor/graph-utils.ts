import type { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeType } from './types';
import { NODE_TYPES } from './node-types';

let idCounter = 0;
export function generateNodeId(type: NodeType): string {
  idCounter++;
  return `n_${type}_${Date.now().toString(36)}_${idCounter}`;
}

export function emptyGraph(): WorkflowGraph {
  const trigger: WorkflowNode = {
    id: generateNodeId('trigger'),
    type: 'trigger',
    config: {},
  };
  const end: WorkflowNode = {
    id: generateNodeId('end'),
    type: 'end',
    config: {},
  };
  return {
    nodes: [trigger, end],
    edges: [{ from: trigger.id, to: end.id }],
  };
}

export function createNode(type: NodeType): WorkflowNode {
  return {
    id: generateNodeId(type),
    type,
    config: { ...NODE_TYPES[type].defaultConfig },
  };
}

export function cloneGraph(g: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(g));
}

export function regenerateIds(g: WorkflowGraph): WorkflowGraph {
  const idMap = new Map<string, string>();
  const nodes: WorkflowNode[] = g.nodes.map((n) => {
    const newId = generateNodeId(n.type);
    idMap.set(n.id, newId);
    return { ...n, id: newId };
  });
  const edges: WorkflowEdge[] = g.edges.map((e) => ({
    ...e,
    from: idMap.get(e.from) ?? e.from,
    to: idMap.get(e.to) ?? e.to,
  }));
  return { nodes, edges };
}
