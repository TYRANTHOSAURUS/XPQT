import {
  Building2, Building, Layers, DoorOpen, Armchair, Presentation,
  Coffee, Archive, Wrench, Car, MapPin,
} from 'lucide-react';
import type { SpaceType } from '@prequest/shared';
import { cn } from '@/lib/utils';

const iconMap: Record<SpaceType, typeof Building2> = {
  site: MapPin,
  building: Building2,
  wing: Building,
  floor: Layers,
  room: DoorOpen,
  desk: Armchair,
  meeting_room: Presentation,
  common_area: Coffee,
  storage_room: Archive,
  technical_room: Wrench,
  parking_space: Car,
};

export const SPACE_TYPE_LABELS: Record<SpaceType, string> = {
  site: 'Site',
  building: 'Building',
  wing: 'Wing',
  floor: 'Floor',
  room: 'Room',
  desk: 'Desk',
  meeting_room: 'Meeting room',
  common_area: 'Common area',
  storage_room: 'Storage room',
  technical_room: 'Technical room',
  parking_space: 'Parking space',
};

export function SpaceTypeIcon({
  type,
  className,
}: {
  type: SpaceType;
  className?: string;
}) {
  const Icon = iconMap[type];
  return <Icon className={cn('size-4 text-muted-foreground', className)} aria-hidden />;
}
