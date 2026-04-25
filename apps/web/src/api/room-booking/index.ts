// Re-export everything; types vs runtime split keeps tree-shaking clean.
export type {
  ReservationListFilters, PickerInput, PickerCriteria, FindTimeInput, SchedulerWindowInput,
} from './keys';
export { roomBookingKeys } from './keys';

export type {
  ReservationStatus, ReservationSource, ReservationType, CalendarProvider,
  RecurrenceRule, PolicySnapshot, Reservation, RuleOutcome, RankedRoom,
  FreeSlot, BookingPayload, MultiRoomBookingPayload,
} from './types';

export {
  reservationListOptions, useReservationList,
  reservationDetailOptions, useReservationDetail,
  pickerOptions, usePicker,
  findTimeOptions, useFindTime,
  schedulerWindowOptions, useSchedulerReservations,
  operatorReservationListOptions, useOperatorReservations,
} from './queries';
export type { OperatorReservationItem } from './queries';

export {
  useCreateBooking, useDryRunBooking, useMultiRoomBooking,
  useEditBooking, useCancelBooking, useRestoreBooking, useCheckInBooking,
} from './mutations';
