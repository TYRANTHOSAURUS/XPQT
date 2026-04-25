import { useCallback, useMemo, useState } from 'react';
import type { PickerInput } from '@/api/room-booking';

/**
 * Top-of-the-page form state for the criteria bar. Drives the picker query
 * (see `usePicker(state.input)`) and is the single source of truth the bar,
 * floor-plan view, and progressive-disclosure controls all read from.
 *
 * Defaults follow the §4.1 spec: today, the next round-half-hour, 1 hour
 * duration, 1 attendee, no must-haves. Site/building/floor are derived from
 * the portal user's `current_location` by the page when the hook mounts —
 * the hook itself doesn't reach into the portal provider.
 */
export interface PickerState {
  date: string;            // yyyy-mm-dd in local tz
  startTime: string;       // HH:mm 24h
  durationMinutes: number;
  attendeeCount: number;
  siteId: string | null;
  buildingId: string | null;
  floorId: string | null;
  mustHaveAmenities: string[];
  hasVideo: boolean;
  wheelchairAccessible: boolean;
  smartKeywords: string[];
  sort: NonNullable<PickerInput['sort']>;
  view: 'list' | 'plan';
}

function nextRoundedSlot(date = new Date()): { date: string; time: string } {
  // Round up to the next 30-min slot in local tz.
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  const minutes = rounded.getMinutes();
  const add = minutes >= 30 ? 60 - minutes : 30 - minutes;
  rounded.setMinutes(minutes + add);
  const yyyy = rounded.getFullYear();
  const mm = String(rounded.getMonth() + 1).padStart(2, '0');
  const dd = String(rounded.getDate()).padStart(2, '0');
  const hh = String(rounded.getHours()).padStart(2, '0');
  const mi = String(rounded.getMinutes()).padStart(2, '0');
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

export interface PickerStateInit {
  siteId?: string | null;
  buildingId?: string | null;
  floorId?: string | null;
}

export function usePickerState(init: PickerStateInit = {}) {
  const seed = useMemo(() => nextRoundedSlot(), []);

  const [state, setState] = useState<PickerState>({
    date: seed.date,
    startTime: seed.time,
    durationMinutes: 60,
    attendeeCount: 1,
    siteId: init.siteId ?? null,
    buildingId: init.buildingId ?? null,
    floorId: init.floorId ?? null,
    mustHaveAmenities: [],
    hasVideo: false,
    wheelchairAccessible: false,
    smartKeywords: [],
    sort: 'best_match',
    view: 'list',
  });

  const update = useCallback(
    <K extends keyof PickerState>(key: K, value: PickerState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const replace = useCallback((next: Partial<PickerState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const startAtIso = useMemo(() => {
    if (!state.date || !state.startTime) return '';
    // Construct in local tz; `new Date('YYYY-MM-DDTHH:mm')` is treated as local.
    return new Date(`${state.date}T${state.startTime}:00`).toISOString();
  }, [state.date, state.startTime]);

  const endAtIso = useMemo(() => {
    if (!startAtIso) return '';
    return new Date(new Date(startAtIso).getTime() + state.durationMinutes * 60_000).toISOString();
  }, [startAtIso, state.durationMinutes]);

  const input: PickerInput = useMemo(
    () => ({
      start_at: startAtIso,
      end_at: endAtIso,
      attendee_count: Math.max(1, state.attendeeCount),
      site_id: state.siteId ?? undefined,
      building_id: state.buildingId ?? undefined,
      floor_id: state.floorId ?? undefined,
      must_have_amenities: state.mustHaveAmenities.length ? state.mustHaveAmenities : undefined,
      has_video: state.hasVideo || undefined,
      wheelchair_accessible: state.wheelchairAccessible || undefined,
      smart_keywords: state.smartKeywords.length ? state.smartKeywords : undefined,
      sort: state.sort,
    }),
    [
      startAtIso,
      endAtIso,
      state.attendeeCount,
      state.siteId,
      state.buildingId,
      state.floorId,
      state.mustHaveAmenities,
      state.hasVideo,
      state.wheelchairAccessible,
      state.smartKeywords,
      state.sort,
    ],
  );

  return { state, update, replace, input, startAtIso, endAtIso };
}
