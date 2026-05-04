// Re-export everything; types vs runtime split keeps tree-shaking clean.
export type {
  ReservationListFilters, PickerInput, PickerCriteria, FindTimeInput,
  SchedulerWindowInput, SchedulerDataInput,
} from './keys';
export { roomBookingKeys } from './keys';

export type {
  ReservationStatus, ReservationSource, ReservationType, CalendarProvider,
  RecurrenceRule, PolicySnapshot, Reservation, RuleOutcome, RankedRoom,
  FreeSlot, BookingPayload, MultiRoomBookingPayload, ServiceLinePayload,
  // Canonical post-rewrite types — prefer these in new code.
  Booking, BookingSlot, BookingStatus, BookingSource, SlotType,
} from './types';

export {
  reservationListOptions, useReservationList,
  reservationDetailOptions, useReservationDetail,
  reservationGroupSiblingsOptions, useReservationGroupSiblings,
  pickerOptions, usePicker,
  findTimeOptions, useFindTime,
  schedulerWindowOptions, useSchedulerReservations,
  schedulerDataOptions, useSchedulerData,
  operatorReservationListOptions, useOperatorReservations,
} from './queries';
export type { OperatorReservationItem, MyReservationItem, SchedulerRoom, GroupSibling } from './queries';

export {
  useCreateBooking, useDryRunBooking, useMultiRoomBooking,
  useEditBooking, useEditBookingSlot,
  useCancelBooking, useRestoreBooking, useCheckInBooking,
  useAttachReservationServices,
} from './mutations';
export type { AttachServicesInput } from './mutations';
