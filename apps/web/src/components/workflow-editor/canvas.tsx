import { useMemo, useCallback, useRef } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  type Node, type Edge, type Connection, type NodeTypes, type OnSelectionChangeParams,
} from 'reactflow';
import { useGraphStore } from './graph-store';
import { applyDagreLayout } from './layout';
import { validate } from './validation';
import { WorkflowNodeCard } from './workflow-node';
import { summarizeNode } from './node-summary';
import { useEditorContextMenu } from './context-menu';

const nodeTypes: NodeTypes = { workflow: WorkflowNodeCard };

export interface CanvasProps {
  readOnly?: boolean;
  runtime?: Record<string, 'visited' | 'current' | 'upcoming'>;
}

export function Canvas({ readOnly = false, runtime }: CanvasProps) {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const selectedIds = useGraphStore((s) => s.selectedIds);
  const setSelection = useGraphStore((s) => s.setSelection);
  const connect = useGraphStore((s) => s.connect);
  const disconnect = useGraphStore((s) => s.disconnect);
  const deleteNodes = useGraphStore((s) => s.deleteNodes);
  const setNodePosition = useGraphStore((s) => s.setNodePosition);

  const selectedIdsRef = useRef<string[]>([]);
  selectedIdsRef.current = selectedIds;

  const { paneHandler, nodeHandler, menu } = useEditorContextMenu({ disabled: readOnly });

  const validationErrors = useMemo(() => validate({ nodes, edges }), [nodes, edges]);
  const invalidIds = useMemo(() => new Set(validationErrors.map((e) => e.nodeId).filter(Boolean) as string[]), [validationErrors]);

  const rfNodes: Node[] = useMemo(() => {
    const raw: Node[] = nodes.map((n) => ({
      id: n.id,
      type: 'workflow',
      position: n.position ?? { x: 0, y: 0 },
      data: {
        node: n,
        invalid: invalidIds.has(n.id),
        summary: summarizeNode(n),
        runtime: runtime?.[n.id],
      },
      selected: selectedIds.includes(n.id),
    }));
    return applyDagreLayout(
      raw,
      edges.map((e, i) => ({ id: `e_${i}`, source: e.from, target: e.to })),
    );
  }, [nodes, edges, invalidIds, runtime, selectedIds]);

  const rfEdges: Edge[] = useMemo(
    () => edges.map((e, i) => ({
      id: `e_${i}_${e.from}_${e.to}_${e.condition ?? 'default'}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.condition && ['true', 'false', 'approved', 'rejected'].includes(e.condition) ? e.condition : undefined,
      label: e.condition && !['true', 'false', 'approved', 'rejected'].includes(e.condition) ? e.condition : undefined,
      animated: runtime?.[e.from] === 'visited' && runtime?.[e.to] !== 'upcoming',
      style: { stroke: e.condition === 'false' || e.condition === 'rejected' ? '#ef4444' : e.condition === 'true' || e.condition === 'approved' ? '#10b981' : '#888' },
    })),
    [edges, runtime],
  );

  const handleConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    connect(c.source, c.target, c.sourceHandle ?? undefined);
  }, [connect]);

  const handleSelectionChange = useCallback(({ nodes: selNodes }: OnSelectionChangeParams) => {
    const next = selNodes.map((n) => n.id);
    const cur = selectedIdsRef.current;
    if (next.length === cur.length && next.every((id, i) => id === cur[i])) return;
    setSelection(next);
  }, [setSelection]);

  const handleEdgesDelete = useCallback((es: Edge[]) => {
    for (const e of es) {
      disconnect(e.source, e.target, (e.sourceHandle as string | undefined) ?? undefined);
    }
  }, [disconnect]);

  const handleNodesDelete = useCallback((deleted: Node[]) => {
    deleteNodes(deleted.map((n) => n.id));
  }, [deleteNodes]);

  const handleNodeDragStop = useCallback((_: unknown, node: Node) => {
    setNodePosition(node.id, node.position);
  }, [setNodePosition]);

  return (
    <>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onNodesDelete={handleNodesDelete}
        onNodeDragStop={handleNodeDragStop}
        onSelectionChange={handleSelectionChange}
        onPaneContextMenu={paneHandler}
        onNodeContextMenu={nodeHandler}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesUpdatable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
      {menu}
    </>
  );
}
