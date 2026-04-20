import { Controller, Get, Post, Patch, Param, Body, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import type { EscalationThreshold, ThresholdTimerScope, ThresholdAction, ThresholdTargetType } from './sla-threshold.types';

const TIMER_SCOPES: readonly ThresholdTimerScope[] = ['response', 'resolution', 'both'];
const ACTIONS: readonly ThresholdAction[] = ['notify', 'escalate'];
const TARGET_TYPES: readonly ThresholdTargetType[] = ['user', 'team', 'manager_of_requester'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateEscalationThresholds(input: unknown): EscalationThreshold[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new BadRequestException('escalation_thresholds must be an array');
  const seen = new Set<string>();
  const out: EscalationThreshold[] = [];
  for (const [i, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException(`escalation_thresholds[${i}] must be an object`);
    }
    const t = raw as Record<string, unknown>;
    const at = t.at_percent;
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 1 || at > 200) {
      throw new BadRequestException(`escalation_thresholds[${i}].at_percent must be an integer in [1, 200]`);
    }
    if (!TIMER_SCOPES.includes(t.timer_type as ThresholdTimerScope)) {
      throw new BadRequestException(`escalation_thresholds[${i}].timer_type must be one of ${TIMER_SCOPES.join(', ')}`);
    }
    if (!ACTIONS.includes(t.action as ThresholdAction)) {
      throw new BadRequestException(`escalation_thresholds[${i}].action must be one of ${ACTIONS.join(', ')}`);
    }
    if (!TARGET_TYPES.includes(t.target_type as ThresholdTargetType)) {
      throw new BadRequestException(`escalation_thresholds[${i}].target_type must be one of ${TARGET_TYPES.join(', ')}`);
    }
    const targetType = t.target_type as ThresholdTargetType;
    let targetId: string | null = null;
    if (targetType === 'manager_of_requester') {
      if (t.target_id !== null && t.target_id !== undefined) {
        throw new BadRequestException(`escalation_thresholds[${i}].target_id must be null for manager_of_requester`);
      }
    } else {
      if (typeof t.target_id !== 'string' || !UUID_RE.test(t.target_id)) {
        throw new BadRequestException(`escalation_thresholds[${i}].target_id must be a uuid`);
      }
      targetId = t.target_id;
    }
    const key = `${at}|${t.timer_type}`;
    if (seen.has(key)) {
      throw new BadRequestException(`escalation_thresholds has duplicate (at_percent=${at}, timer_type=${String(t.timer_type)})`);
    }
    seen.add(key);
    out.push({
      at_percent: at,
      timer_type: t.timer_type as ThresholdTimerScope,
      action: t.action as ThresholdAction,
      target_type: targetType,
      target_id: targetId,
    });
  }
  return out;
}

@Controller('sla-policies')
export class SlaPolicyController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('sla_policies')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }

  @Post()
  async create(@Body() dto: { name: string; response_time_minutes?: number; resolution_time_minutes?: number; escalation_thresholds?: unknown; [k: string]: unknown }) {
    const tenant = TenantContext.current();
    const payload: Record<string, unknown> = { ...dto, tenant_id: tenant.id };
    if ('escalation_thresholds' in dto) {
      payload.escalation_thresholds = validateEscalationThresholds(dto.escalation_thresholds);
    }
    const { data, error } = await this.supabase.admin
      .from('sla_policies')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const payload: Record<string, unknown> = { ...dto };
    if ('escalation_thresholds' in dto) {
      payload.escalation_thresholds = validateEscalationThresholds(dto.escalation_thresholds);
    }
    const { data, error } = await this.supabase.admin
      .from('sla_policies')
      .update(payload)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}
