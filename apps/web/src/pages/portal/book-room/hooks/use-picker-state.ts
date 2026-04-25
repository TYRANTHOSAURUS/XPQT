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
  // Snap to the next 30-min slot, then nudge into business hours so the
  // default doesn't land on Sunday 21:30 — which fires every off-hours
  // rule and floods the picker with "Needs approval".
  //
  // Heuristic — server resolves the actual rules; this is just a UX nudge
  // for the initial view. Conservative envelope: 09:00–17:00 Mon–Fri.
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  const minutes = rounded.getMinutes();
  const add = minutes >= 30 ? 60 - minutes : 30 - minutes;
  rounded.setMinutes(minutes + add);

  const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
  const hour = rounded.getHours();
  if (isWeekend(rounded) || hour < 9 || hour >= 17) {
    do {
      rounded.setDate(rounded.getDate() + 1);
    } while (isWeekend(rounded));
    rounded.setHours(9, 0, 0, 0);
  }

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

  // Server expects criteria nested under `criteria` (matches PickerDto).
  // Top-level must_have_amenities etc. are silently ignored by the backend.
  const input: PickerInput = useMemo(
    () => {
      const criteria = {
        ...(state.mustHaveAmenities.length ? { must_have_amenities: state.mustHaveAmenities } : {}),
        ...(state.hasVideo ? { has_video: true } : {}),
        ...(state.wheelchairAccessible ? { wheelchair_accessible: true } : {}),
        ...(state.smartKeywords.length ? { smart_keywords: state.smartKeywords } : {}),
      };
      return {
        start_at: startAtIso,
        end_at: endAtIso,
        attendee_count: Math.max(1, state.attendeeCount),
        site_id: state.siteId ?? undefined,
        building_id: state.buildingId ?? undefined,
        floor_id: state.floorId ?? undefined,
        criteria: Object.keys(criteria).length ? criteria : undefined,
        sort: state.sort,
      };
    },
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
