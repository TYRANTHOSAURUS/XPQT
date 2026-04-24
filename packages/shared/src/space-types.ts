import { SpaceType } from './types/enums';

/**
 * Canonical space-type taxonomy. Mirrors the DB check constraint in
 * supabase/migrations/00113_space_wing_and_parent_rule.sql. If you change
 * either, change both.
 */
export const SPACE_TYPES = [
  'site',
  'building',
  'wing',
  'floor',
  'room',
  'desk',
  'meeting_room',
  'common_area',
  'storage_room',
  'technical_room',
  'parking_space',
] as const;

/**
 * Parent → allowed children. `null` parent means the tenant root.
 * Mirrors `public.is_valid_space_parent` in the DB.
 */
export const SPACE_PARENT_RULES: Record<SpaceType | 'root', readonly SpaceType[]> = {
  root: ['site'],
  site: ['building', 'common_area', 'parking_space'],
  building: ['wing', 'floor', 'common_area'],
  wing: ['floor'],
  floor: ['room', 'meeting_room', 'common_area', 'storage_room', 'technical_room'],
  room: ['desk'],
  desk: [],
  meeting_room: [],
  common_area: [],
  storage_room: [],
  technical_room: [],
  parking_space: [],
};

export function isValidSpaceParent(
  parentType: SpaceType | null,
  childType: SpaceType,
): boolean {
  const key = parentType ?? 'root';
  return SPACE_PARENT_RULES[key].includes(childType);
}

export function allowedChildTypes(parentType: SpaceType | null): readonly SpaceType[] {
  return SPACE_PARENT_RULES[parentType ?? 'root'];
}
