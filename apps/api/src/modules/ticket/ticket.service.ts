import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class TicketService {
  constructor(private readonly supabase: SupabaseService) {}

  async listForCurrentTenant() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tickets')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return data;
  }
}
