import type { Tool } from './tool';

export const selectTool: Tool = {
  onPointerDown({ dispatch }) {
    dispatch({ type: 'select-polygon', index: null });
  },
};
