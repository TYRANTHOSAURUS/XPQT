import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface MealWindowRow {
  id: string;
  tenant_id: string;
  label: string;
  /** "HH:MM:SS" local time. Postgres `time` round-trips as a string via
   *  supabase-js, not a Date. */
  start_time: string;
  end_time: string;
  active: boolean;
}

/**
 * Read-side loader for `tenant_meal_windows`. The create-booking modal
 * uses these windows client-side to render a "Suggested" chip on the
 * catering add-in card when the picked booking time overlaps a window.
 *
 * Writes are deferred to the admin UI follow-up; v1 ships with the seed
 * defaults from migration 00283 (Lunch 11:30–13:30, Dinner 17:00–19:00).
 */
@Injectable()
export class MealWindowsService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(): Promise<MealWindowRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tenant_meal_windows')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('start_time', { ascending: true });
    if (error) throw error;
    return (data ?? []) as MealWindowRow[];
  }
}
