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

// A single accent color per node type. Used sparingly — only the left rail +
// the icon. No tinted backgrounds, no rounded badges.
const ACCENT: Record<NodeType, string> = {
  trigger: 'text-emerald-500',
  end: 'text-zinc-500',
  assign: 'text-blue-500',
  approval: 'text-violet-500',
  notification: 'text-cyan-500',
  condition: 'text-amber-500',
  update_ticket: 'text-indigo-500',
  create_child_tasks: 'text-fuchsia-500',
  wait_for: 'text-orange-500',
  timer: 'text-rose-500',
  http_request: 'text-teal-500',
};

const RAIL: Record<NodeType, string> = {
  trigger: 'bg-emerald-500',
  end: 'bg-zinc-500',
  assign: 'bg-blue-500',
  approval: 'bg-violet-500',
  notification: 'bg-cyan-500',
  condition: 'bg-amber-500',
  update_ticket: 'bg-indigo-500',
  create_child_tasks: 'bg-fuchsia-500',
  wait_for: 'bg-orange-500',
  timer: 'bg-rose-500',
  http_request: 'bg-teal-500',
};

const HANDLE_CLASS =
  '!w-2 !h-2 !rounded-full !border-0 !bg-muted-foreground/50 hover:!bg-foreground ' +
  'hover:!scale-125 transition-all';

export function WorkflowNodeCard({ data, selected }: NodeProps<NodeData>) {
  const type = data.node.type as NodeType;
  const meta = NODE_TYPES[type];
  const Icon = meta.icon;
  const showTrueFalse = type === 'condition';
  const showApprovedRejected = type === 'approval';
  const isEnd = type === 'end';
  const isTrigger = type === 'trigger';
  const customLabel = data.node.config.label as string | undefined;
  const title = customLabel || meta.label;

  return (
    <div
      className={cn(
        'group relative flex w-[216px] items-stretch overflow-hidden rounded-md border border-border/80 bg-card text-card-foreground',
        // Elevation — the canvas pane is tinted so nodes need a soft drop to
        // read as lifted. Double layer for softness; stronger in dark mode
        // because a light-mode-tuned shadow disappears on black.
        'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)]',
        'dark:shadow-[0_2px_4px_rgba(0,0,0,0.4),0_8px_24px_rgba(0,0,0,0.2)]',
        'transition-[border-color,box-shadow,transform] duration-100',
        'hover:border-foreground/30 hover:-translate-y-px',
        // Selected / runtime states use ring (outer, doesn't override the
        // base elevation shadow) instead of stacking box-shadows.
        selected && 'border-foreground/60 ring-1 ring-foreground/60',
        data.invalid && !selected && 'border-red-500/70',
        data.runtime === 'current' && 'border-emerald-500 ring-1 ring-emerald-500',
        data.runtime === 'visited' && 'opacity-80',
        data.runtime === 'upcoming' && 'opacity-45',
      )}
    >
      <span className={cn('w-[2px] shrink-0', RAIL[type])} aria-hidden />

      <Handle
        type="target"
        position={Position.Left}
        className={cn(HANDLE_CLASS, isTrigger && '!opacity-0 !pointer-events-none')}
      />

      <div className="min-w-0 flex-1 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <Icon className={cn('h-3.5 w-3.5 shrink-0', ACCENT[type])} strokeWidth={2.25} />
          <span className="flex-1 truncate text-[12.5px] font-medium leading-tight tracking-tight">
            {title}
          </span>
          {data.invalid && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500"
              aria-label="Needs configuration"
              title="Needs configuration"
            />
          )}
        </div>
        {data.summary && (
          <div className="mt-1 truncate pl-[22px] text-[11px] leading-tight text-muted-foreground/90">
            {data.summary}
          </div>
        )}
      </div>

      {!isEnd && !showTrueFalse && !showApprovedRejected && (
        <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
      )}

      {showTrueFalse && (
        <>
          <Handle id="true" type="source" position={Position.Right} className={cn(HANDLE_CLASS, '!bg-emerald-500')} style={{ top: '38%' }} />
          <Handle id="false" type="source" position={Position.Right} className={cn(HANDLE_CLASS, '!bg-red-500')} style={{ top: '72%' }} />
          <span className="pointer-events-none absolute right-[-32px] top-[34%] text-[10px] font-medium text-emerald-600 dark:text-emerald-400">true</span>
          <span className="pointer-events-none absolute right-[-32px] top-[68%] text-[10px] font-medium text-red-600 dark:text-red-400">false</span>
        </>
      )}

      {showApprovedRejected && (
        <>
          <Handle id="approved" type="source" position={Position.Right} className={cn(HANDLE_CLASS, '!bg-emerald-500')} style={{ top: '38%' }} />
          <Handle id="rejected" type="source" position={Position.Right} className={cn(HANDLE_CLASS, '!bg-red-500')} style={{ top: '72%' }} />
          <span className="pointer-events-none absolute right-[-54px] top-[34%] text-[10px] font-medium text-emerald-600 dark:text-emerald-400">approved</span>
          <span className="pointer-events-none absolute right-[-54px] top-[68%] text-[10px] font-medium text-red-600 dark:text-red-400">rejected</span>
        </>
      )}
    </div>
  );
}
