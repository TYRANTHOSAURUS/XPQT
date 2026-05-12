import type { Polygon, Label } from '@/api/floor-plans/types';

export type ToolKind = 'select' | 'draw-polygon' | 'draw-rectangle' | 'stamp-seat' | 'image-upload';

export type DesignerState = {
  draftId: string;
  updatedAt: string;           // server version for If-Match
  imageUrl: string | null;
  previewUrl: string | null;   // in-memory signed URL for designer preview (not persisted)
  widthPx: number | null;
  heightPx: number | null;
  polygons: Polygon[];
  labels: Label[];
  selectedPolygonIndex: number | null;
  activeTool: ToolKind;
  inProgressPolygon: Polygon | null;
};
