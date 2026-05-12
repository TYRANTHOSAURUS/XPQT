import type { Tool } from './tool';

export const drawRectangleTool: Tool = {
  onPointerDown({ dispatch, worldX, worldY }) {
    dispatch({ type: 'start-drawing', polygon: { space_id: '', points: [{ x: worldX, y: worldY }] } });
  },
  onPointerMove({ state, dispatch, worldX, worldY }) {
    const start = state.inProgressPolygon?.points[0];
    if (!start) return;
    const rect = [
      start,
      { x: worldX, y: start.y },
      { x: worldX, y: worldY },
      { x: start.x, y: worldY },
    ];
    dispatch({ type: 'start-drawing', polygon: { space_id: '', points: rect } });
  },
  onPointerUp({ dispatch }) {
    dispatch({ type: 'commit-drawing' });
  },
};
