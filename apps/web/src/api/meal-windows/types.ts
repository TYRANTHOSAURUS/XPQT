export interface MealWindow {
  id: string;
  tenant_id: string;
  label: string;
  /** "HH:MM:SS" local time, e.g. "11:30:00". */
  start_time: string;
  end_time: string;
  active: boolean;
}
