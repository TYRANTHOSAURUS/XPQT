import { useEffect, useMemo } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { Canvas } from './canvas';
import { useGraphStore } from './graph-store';
import type { WorkflowGraph } from './types';
import type { InstanceEvent } from './history-timeline';

export interface RuntimeViewerProps {
  graph: WorkflowGraph;
  events: InstanceEvent[];
  currentNodeId: string | null;
}

export function RuntimeViewer({ graph, events, currentNodeId }: RuntimeViewerProps) {
  const setGraph = useGraphStore((s) => s.setGraph);

  useEffect(() => { setGraph(graph); }, [graph, setGraph]);

  const runtime = useMemo(() => {
    const visited = new Set<string>();
    for (const e of events) if (e.event_type === 'node_entered' && e.node_id) visited.add(e.node_id);
    const map: Record<string, 'visited' | 'current' | 'upcoming'> = {};
    for (const n of graph.nodes) {
      if (n.id === currentNodeId) map[n.id] = 'current';
      else if (visited.has(n.id)) map[n.id] = 'visited';
      else map[n.id] = 'upcoming';
    }
    return map;
  }, [events, currentNodeId, graph.nodes]);

  return (
    <ReactFlowProvider>
      <Canvas readOnly runtime={runtime} />
    </ReactFlowProvider>
  );
}
