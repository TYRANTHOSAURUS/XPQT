import dagre from 'dagre';
import { Position } from 'reactflow';
import type { Node, Edge } from 'reactflow';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

export function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  // Preserve any node that already has a non-zero position (user-dragged or persisted).
  // Only auto-layout unpositioned nodes (fresh load, newly added from palette).
  const needsLayout = nodes.some((n) => !n.position || (n.position.x === 0 && n.position.y === 0));
  if (!needsLayout) {
    return nodes.map((n) => ({
      ...n,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
    }));
  }

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 80 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map((n) => {
    const hasPos = n.position && (n.position.x !== 0 || n.position.y !== 0);
    if (hasPos) {
      return { ...n, targetPosition: Position.Left, sourcePosition: Position.Right };
    }
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
    };
  });
}
