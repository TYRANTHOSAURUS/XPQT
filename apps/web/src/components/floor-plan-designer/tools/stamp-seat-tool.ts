import type { Tool } from './tool';

export const stampSeatTool: Tool = {
  onPointerDown({ dispatch, worldX, worldY }) {
    const w = 60, h = 40;
    dispatch({
      type: 'add-polygon',
      polygon: {
        space_id: '', // inspector picker links the space (B.9)
        points: [
          { x: worldX - w / 2, y: worldY - h / 2 },
          { x: worldX + w / 2, y: worldY - h / 2 },
          { x: worldX + w / 2, y: worldY + h / 2 },
          { x: worldX - w / 2, y: worldY + h / 2 },
        ],
        render_hint: 'seat',
      },
    });
  },
};
