import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { wrapPgError } from '../../common/errors';

export interface WorkingHoursDay {
  start: string;
  end: string;
}

export interface WorkingHoursConfig {
  monday: WorkingHoursDay | null;
  tuesday: WorkingHoursDay | null;
  wednesday: WorkingHoursDay | null;
  thursday: WorkingHoursDay | null;
  friday: WorkingHoursDay | null;
  saturday: WorkingHoursDay | null;
  sunday: WorkingHoursDay | null;
}

export interface Holiday {
  date: string;
  name: string;
  recurring: boolean;
}

export interface CreateBusinessHoursDto {
  name: string;
  time_zone: string;
  working_hours?: WorkingHoursConfig;
  holidays?: Holiday[];
}

@Injectable()
export class BusinessHoursService {
  constructor(private readonly supabase: SupabaseService) {}

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('business_hours_calendars')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) {
      throw wrapPgError(error, 'business_hours.list_failed', {
        detail: 'Business hours calendar list query failed',
      });
    }
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('business_hours_calendars')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();
    if (error) {
      throw wrapPgError(error, 'business_hours.lookup_failed', {
        detail: `Business hours calendar lookup failed for id ${id}`,
        notFoundCode: 'business_hours.not_found',
      });
    }
    return data;
  }

  async create(dto: CreateBusinessHoursDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('business_hours_calendars')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();
    if (error) {
      throw wrapPgError(error, 'business_hours.create_failed', {
        detail: 'Business hours calendar insert failed',
      });
    }
    return data;
  }

  async update(id: string, dto: Partial<CreateBusinessHoursDto>) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('business_hours_calendars')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) {
      throw wrapPgError(error, 'business_hours.update_failed', {
        detail: `Business hours calendar update failed for id ${id}`,
        notFoundCode: 'business_hours.not_found',
      });
    }
    return data;
  }
}
