import type { SpaceType } from '@prequest/shared';

export interface Space {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  type: SpaceType;
  code: string | null;
  name: string;
  capacity: number | null;
  amenities: string[] | null;
  attributes: Record<string, unknown> | null;
  reservable: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SpaceTreeNode extends Space {
  child_count: number;
  children: SpaceTreeNode[];
}

export interface CreateSpacePayload {
  parent_id: string | null;
  type: SpaceType;
  name: string;
  code?: string;
  capacity?: number;
  amenities?: string[];
  reservable?: boolean;
}

export interface UpdateSpacePayload {
  name?: string;
  code?: string;
  capacity?: number | null;
  amenities?: string[];
  reservable?: boolean;
  active?: boolean;
}

export interface BulkUpdateResult {
  results: Array<{ id: string; ok: boolean; error?: string }>;
}
