import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingRuleCreateSchema, RoutingRuleUpdateSchema } from './routing-rule-validators';

@Controller('routing-rules')
export class RoutingRuleController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('routing_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('priority', { ascending: false });
    if (error) throw error;
    return data;
  }

  @Post()
  async create(@Body() body: unknown) {
    const parsed = RoutingRuleCreateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('routing_rules')
      .insert({ ...parsed.data, tenant_id: tenant.id })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const parsed = RoutingRuleUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('routing_rules')
      .update(parsed.data)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

// Zod errors are nested — join the first few human-readable messages for a
// compact 400 body the UI can display without needing to understand zod.
function formatZodError(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const msgs = err.issues.slice(0, 3).map((i) => {
    const path = i.path.length ? i.path.map(String).join('.') : '(body)';
    return `${path}: ${i.message}`;
  });
  return `Invalid routing rule — ${msgs.join('; ')}`;
}
