import { Handle, Position, type NodeProps } from 'reactflow';
import { NODE_TYPES } from './node-types';
import type { NodeType, WorkflowNode } from './types';
import { cn } from '@/lib/utils';

interface NodeData {
  node: WorkflowNode;
  invalid?: boolean;
  summary?: string;
  runtime?: 'visited' | 'current' | 'upcoming';
}

export function WorkflowNodeCard({ data, selected }: NodeProps<NodeData>) {
  const meta = NODE_TYPES[data.node.type as NodeType];
  const Icon = meta.icon;
  const showTrueFalse = data.node.type === 'condition';
  const showApprovedRejected = data.node.type === 'approval';
  const isEnd = data.node.type === 'end';

  return (
    <div
      className={cn(
        'relative rounded-lg border-2 bg-card text-card-foreground shadow-sm w-[200px] transition-all',
        meta.colorClass,
        selected && 'ring-2 ring-offset-2 ring-offset-background ring-foreground',
        data.invalid && 'border-red-500',
        data.runtime === 'current' && 'ring-2 ring-offset-2 ring-offset-background ring-emerald-500 animate-pulse',
        data.runtime === 'visited' && 'opacity-80',
        data.runtime === 'upcoming' && 'opacity-40',
      )}
    >
      <Handle type="target" position={Position.Left} className={cn(data.node.type === 'trigger' && 'opacity-0 pointer-events-none')} />
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="font-medium text-sm">{(data.node.config.label as string) || meta.label}</span>
        </div>
        {data.summary && <div className="text-xs text-muted-foreground mt-1 truncate">{data.summary}</div>}
      </div>
      {!isEnd && !showTrueFalse && !showApprovedRejected && (
        <Handle type="source" position={Position.Right} />
      )}
      {showTrueFalse && (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: '35%' }} />
          <Handle id="false" type="source" position={Position.Right} style={{ top: '65%' }} />
          <div className="absolute -right-10 top-[30%] text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">true</div>
          <div className="absolute -right-10 top-[60%] text-[10px] text-red-600 dark:text-red-400 font-medium">false</div>
        </>
      )}
      {showApprovedRejected && (
        <>
          <Handle id="approved" type="source" position={Position.Right} style={{ top: '35%' }} />
          <Handle id="rejected" type="source" position={Position.Right} style={{ top: '65%' }} />
          <div className="absolute -right-14 top-[30%] text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">approved</div>
          <div className="absolute -right-14 top-[60%] text-[10px] text-red-600 dark:text-red-400 font-medium">rejected</div>
        </>
      )}
    </div>
  );
}
