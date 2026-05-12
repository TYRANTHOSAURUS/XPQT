import type { Tool } from './tool';

export const drawPolygonTool: Tool = {
  onPointerDown({ state, dispatch, worldX, worldY }) {
    const inProgress = state.inProgressPolygon;
    if (!inProgress) {
      dispatch({ type: 'start-drawing', polygon: { space_id: '', points: [{ x: worldX, y: worldY }] } });
    } else {
      dispatch({
        type: 'start-drawing',
        polygon: { ...inProgress, points: [...inProgress.points, { x: worldX, y: worldY }] },
      });
    }
  },
};
