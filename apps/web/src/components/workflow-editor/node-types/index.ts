import {
  Play, Square, UserPlus, CheckSquare, Bell, GitBranch,
  Edit3, ListTree, Pause, Clock,
} from 'lucide-react';
import type { NodeType } from '../types';

export interface NodeTypeMeta {
  type: NodeType;
  label: string;
  description: string;
  icon: typeof Play;
  colorClass: string;
  defaultConfig: Record<string, unknown>;
  outgoingEdges: 'single' | 'none' | 'condition' | 'approval';
}

export const NODE_TYPES: Record<NodeType, NodeTypeMeta> = {
  trigger: {
    type: 'trigger', label: 'Trigger', description: 'Workflow start',
    icon: Play, colorClass: 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    defaultConfig: {}, outgoingEdges: 'single',
  },
  end: {
    type: 'end', label: 'End', description: 'Workflow complete',
    icon: Square, colorClass: 'border-zinc-400 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    defaultConfig: {}, outgoingEdges: 'none',
  },
  assign: {
    type: 'assign', label: 'Assign', description: 'Assign ticket to team or user',
    icon: UserPlus, colorClass: 'border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-400',
    defaultConfig: { team_id: null, user_id: null }, outgoingEdges: 'single',
  },
  approval: {
    type: 'approval', label: 'Approval', description: 'Request approval (pauses workflow)',
    icon: CheckSquare, colorClass: 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-400',
    defaultConfig: { approver_person_id: null, approver_team_id: null },
    outgoingEdges: 'approval',
  },
  notification: {
    type: 'notification', label: 'Notify', description: 'Send notification',
    icon: Bell, colorClass: 'border-cyan-500 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400',
    defaultConfig: { notification_type: 'workflow_notification', subject: '', body: '' },
    outgoingEdges: 'single',
  },
  condition: {
    type: 'condition', label: 'Condition', description: 'Branch on ticket field',
    icon: GitBranch, colorClass: 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    defaultConfig: { field: '', operator: 'equals', value: '' },
    outgoingEdges: 'condition',
  },
  update_ticket: {
    type: 'update_ticket', label: 'Update Ticket', description: 'Set ticket fields',
    icon: Edit3, colorClass: 'border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
    defaultConfig: { fields: {} }, outgoingEdges: 'single',
  },
  create_child_tasks: {
    type: 'create_child_tasks', label: 'Create Child Tasks', description: 'Spawn sub-tickets',
    icon: ListTree, colorClass: 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400',
    defaultConfig: { tasks: [] }, outgoingEdges: 'single',
  },
  wait_for: {
    type: 'wait_for', label: 'Wait For', description: 'Pause until signal (child tasks, status, event)',
    icon: Pause, colorClass: 'border-orange-500 bg-orange-500/10 text-orange-700 dark:text-orange-400',
    defaultConfig: { wait_type: 'child_tasks' }, outgoingEdges: 'single',
  },
  timer: {
    type: 'timer', label: 'Timer', description: 'Pause for N minutes',
    icon: Clock, colorClass: 'border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-400',
    defaultConfig: { delay_minutes: 60 }, outgoingEdges: 'single',
  },
};

export const NODE_TYPE_LIST: NodeTypeMeta[] = Object.values(NODE_TYPES);
