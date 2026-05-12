import type { DesignerState } from '../types';

export type ToolContext = {
  state: DesignerState;
  dispatch: React.Dispatch<any>;
  worldX: number;
  worldY: number;
};

export interface Tool {
  onPointerDown?(ctx: ToolContext): void;
  onPointerMove?(ctx: ToolContext): void;
  onPointerUp?(ctx: ToolContext): void;
}
