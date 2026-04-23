import { useMemo, useCallback, useRef } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap, MarkerType,
  type Node, type Edge, type Connection, type NodeTypes, type EdgeTypes, type OnSelectionChangeParams,
} from 'reactflow';
import { useGraphStore } from './graph-store';
import { applyDagreLayout } from './layout';
import { validate } from './validation';
import { WorkflowNodeCard } from './workflow-node';
import { WorkflowEdge, type WorkflowEdgeData } from './workflow-edge';
import { summarizeNode } from './node-summary';
import { useEditorContextMenu } from './context-menu';

const nodeTypes: NodeTypes = { workflow: WorkflowNodeCard };
const edgeTypes: EdgeTypes = { workflow: WorkflowEdge };

export interface CanvasProps {
  readOnly?: boolean;
  runtime?: Record<string, 'visited' | 'current' | 'upcoming'>;
}

function edgeTone(condition: string | undefined): WorkflowEdgeData['tone'] {
  if (condition === 'true' || condition === 'approved') return 'success';
  if (condition === 'false' || condition === 'rejected') return 'danger';
  return 'default';
}

function edgeLabel(condition: string | undefined): string | undefined {
  if (!condition) return undefined;
  if (['true', 'false', 'approved', 'rejected'].includes(condition)) return condition;
  return condition;
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

  const rfEdges: Edge<WorkflowEdgeData>[] = useMemo(
    () => edges.map((e, i) => {
      const tone = edgeTone(e.condition);
      const label = edgeLabel(e.condition);
      const runtimeActive = runtime ? runtime[e.from] === 'visited' && runtime[e.to] !== 'upcoming' : false;
      return {
        id: `e_${i}_${e.from}_${e.to}_${e.condition ?? 'default'}`,
        source: e.from,
        target: e.to,
        type: 'workflow',
        sourceHandle: e.condition && ['true', 'false', 'approved', 'rejected'].includes(e.condition) ? e.condition : undefined,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color:
            tone === 'success' ? '#10b981'
              : tone === 'danger' ? '#ef4444'
                : '#94a3b8',
        },
        data: { condition: e.condition, label, tone, runtimeActive, readOnly },
      };
    }),
    [edges, runtime, readOnly],
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
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'workflow' }}
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
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} className="!shadow-none !border !rounded overflow-hidden" />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(0,0,0,0.04)"
          className="!rounded !border !shadow-none"
        />
      </ReactFlow>
      {menu}
    </>
  );
}
