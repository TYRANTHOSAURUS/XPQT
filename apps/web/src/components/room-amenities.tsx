/**
 * Amenity slug → icon map shared by the scheduler row and the room
 * detail dialog. Three different vocabularies exist in the codebase
 * (seed migrations, SpaceFormDialog checkboxes, scheduler toolbar
 * room-type filter) — until they're reconciled, this map covers every
 * variant the UI may receive so nothing falls through to the chip
 * fallback.
 */
import {
  Accessibility,
  Armchair,
  Coffee,
  LampDesk,
  Lock,
  Monitor,
  Phone,
  Presentation,
  Printer,
  Projector,
  Refrigerator,
  Tv,
  UserCheck,
  Video,
  type LucideIcon,
} from 'lucide-react';

export const ROOM_AMENITY_ICONS: Record<string, { Icon: LucideIcon; label: string }> = {
  // Display / AV
  display: { Icon: Tv, label: 'Display' },
  tv: { Icon: Tv, label: 'TV' },
  projector: { Icon: Projector, label: 'Projector' },
  whiteboard: { Icon: Presentation, label: 'Whiteboard' },
  video: { Icon: Video, label: 'Video conferencing' },
  video_conference: { Icon: Video, label: 'Video conferencing' },
  video_conferencing: { Icon: Video, label: 'Video conferencing' },
  phone_conf: { Icon: Phone, label: 'Phone conferencing' },
  phone: { Icon: Phone, label: 'Phone' },

  // Workspace furniture
  desks: { Icon: Armchair, label: 'Desks' },
  standing_desk: { Icon: LampDesk, label: 'Standing desk' },
  dual_monitor: { Icon: Monitor, label: 'Dual monitor' },
  monitor: { Icon: Monitor, label: 'Monitor' },

  // Amenities / utilities
  coffee: { Icon: Coffee, label: 'Coffee' },
  fridge: { Icon: Refrigerator, label: 'Fridge' },
  printer: { Icon: Printer, label: 'Printer' },
  lockers: { Icon: Lock, label: 'Lockers' },
  visitor_desk: { Icon: UserCheck, label: 'Visitor desk' },
  wheelchair_accessible: { Icon: Accessibility, label: 'Wheelchair accessible' },
};

export function humanizeAmenity(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function amenityMeta(slug: string): { Icon: LucideIcon | null; label: string } {
  const hit = ROOM_AMENITY_ICONS[slug];
  if (hit) return hit;
  return { Icon: null, label: humanizeAmenity(slug) };
}
