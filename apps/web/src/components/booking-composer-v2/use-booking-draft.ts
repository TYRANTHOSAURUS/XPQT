import { useCallback, useMemo, useState } from 'react';
import {
  draftFromComposerSeed,
  type BookingDraft,
  type BookingDraftSeed,
} from './booking-draft';
import type { RecurrenceRule } from '@/api/room-booking';
import type { PickerSelection } from '../booking-composer/service-picker-sheet';
import type { PendingVisitor } from '../booking-composer/state';

export interface UseBookingDraftOptions {
  seed?: BookingDraftSeed;
}

export interface UseBookingDraftResult {
  draft: BookingDraft;
  setRoom: (spaceId: string | null) => void;
  setTime: (startAt: string | null, endAt: string | null) => void;
  setTitle: (title: string) => void;
  setDescription: (description: string) => void;
  setHost: (personId: string | null) => void;
  setRequester: (personId: string | null) => void;
  setAttendeeCount: (count: number) => void;
  setRepeat: (rule: RecurrenceRule | null) => void;
  setServices: (services: PickerSelection[]) => void;
  addVisitor: (visitor: PendingVisitor) => void;
  updateVisitor: (visitor: PendingVisitor) => void;
  removeVisitor: (localId: string) => void;
  setCostCenter: (costCenterId: string | null) => void;
  setTemplateId: (templateId: string | null) => void;
  /** Replace the entire draft. Used by the popover→modal escalation
   *  path: the modal opens with the popover's draft as its seed. */
  replace: (next: BookingDraft) => void;
  reset: (seed?: BookingDraftSeed) => void;
}

/**
 * Single state container for the redesigned booking composer. Shared by
 * the popover (small subset) and the modal (full draft). Setters are
 * stable identity (useCallback) so child components don't re-render
 * just because a parent re-renders.
 */
export function useBookingDraft(
  options: UseBookingDraftOptions = {},
): UseBookingDraftResult {
  const [draft, setDraft] = useState<BookingDraft>(() =>
    draftFromComposerSeed(options.seed),
  );

  const setRoom = useCallback((spaceId: string | null) => {
    setDraft((d) => ({ ...d, spaceId }));
  }, []);
  const setTime = useCallback((startAt: string | null, endAt: string | null) => {
    setDraft((d) => ({ ...d, startAt, endAt }));
  }, []);
  const setTitle = useCallback((title: string) => {
    setDraft((d) => ({ ...d, title }));
  }, []);
  const setDescription = useCallback((description: string) => {
    setDraft((d) => ({ ...d, description }));
  }, []);
  const setHost = useCallback((hostPersonId: string | null) => {
    setDraft((d) => ({ ...d, hostPersonId }));
  }, []);
  const setRequester = useCallback((requesterPersonId: string | null) => {
    setDraft((d) => ({ ...d, requesterPersonId }));
  }, []);
  const setAttendeeCount = useCallback((count: number) => {
    setDraft((d) => ({ ...d, attendeeCount: Math.max(1, count) }));
  }, []);
  const setRepeat = useCallback((recurrence: RecurrenceRule | null) => {
    setDraft((d) => ({ ...d, recurrence }));
  }, []);
  const setServices = useCallback((services: PickerSelection[]) => {
    setDraft((d) => ({ ...d, services }));
  }, []);
  const addVisitor = useCallback((visitor: PendingVisitor) => {
    setDraft((d) => {
      if (d.visitors.some((v) => v.local_id === visitor.local_id)) {
        return {
          ...d,
          visitors: d.visitors.map((v) =>
            v.local_id === visitor.local_id ? visitor : v,
          ),
        };
      }
      return { ...d, visitors: [...d.visitors, visitor] };
    });
  }, []);
  const updateVisitor = useCallback((visitor: PendingVisitor) => {
    setDraft((d) => ({
      ...d,
      visitors: d.visitors.map((v) =>
        v.local_id === visitor.local_id ? visitor : v,
      ),
    }));
  }, []);
  const removeVisitor = useCallback((localId: string) => {
    setDraft((d) => ({
      ...d,
      visitors: d.visitors.filter((v) => v.local_id !== localId),
    }));
  }, []);
  const setCostCenter = useCallback((costCenterId: string | null) => {
    setDraft((d) => ({ ...d, costCenterId }));
  }, []);
  const setTemplateId = useCallback((templateId: string | null) => {
    setDraft((d) => ({ ...d, templateId }));
  }, []);
  const replace = useCallback((next: BookingDraft) => {
    setDraft(next);
  }, []);
  const reset = useCallback((seed?: BookingDraftSeed) => {
    setDraft(draftFromComposerSeed(seed));
  }, []);

  return useMemo(
    () => ({
      draft,
      setRoom,
      setTime,
      setTitle,
      setDescription,
      setHost,
      setRequester,
      setAttendeeCount,
      setRepeat,
      setServices,
      addVisitor,
      updateVisitor,
      removeVisitor,
      setCostCenter,
      setTemplateId,
      replace,
      reset,
    }),
    [
      draft,
      setRoom,
      setTime,
      setTitle,
      setDescription,
      setHost,
      setRequester,
      setAttendeeCount,
      setRepeat,
      setServices,
      addVisitor,
      updateVisitor,
      removeVisitor,
      setCostCenter,
      setTemplateId,
      replace,
      reset,
    ],
  );
}
