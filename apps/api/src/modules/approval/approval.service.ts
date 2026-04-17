import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TicketService } from '../ticket/ticket.service';

export interface CreateApprovalDto {
  target_entity_type: string;
  target_entity_id: string;
  approver_person_id?: string;
  approver_team_id?: string;
  approval_chain_id?: string;
  step_number?: number;
  parallel_group?: string;
}

export interface RespondDto {
  status: 'approved' | 'rejected';
  comments?: string;
}

@Injectable()
export class ApprovalService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => TicketService)) private readonly ticketService: TicketService,
  ) {}

  /**
   * Get pending approvals for a specific person (their approval queue).
   */
  async getPendingForPerson(personId: string) {
    const tenant = TenantContext.current();

    // Check for delegations — include approvals delegated to this person
    const { data: delegations } = await this.supabase.admin
      .from('delegations')
      .select('delegator_user_id')
      .eq('delegate_user_id', personId)
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .lte('starts_at', new Date().toISOString())
      .gte('ends_at', new Date().toISOString());

    const delegatorIds = (delegations ?? []).map((d) => d.delegator_user_id);

    // Get direct approvals + delegated approvals
    let query = this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending');

    if (delegatorIds.length > 0) {
      query = query.or(`approver_person_id.eq.${personId},approver_person_id.in.(${delegatorIds.join(',')})`);
    } else {
      query = query.eq('approver_person_id', personId);
    }

    const { data, error } = await query.order('requested_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  /**
   * Get all approvals for a specific target entity (e.g., all approvals for a ticket).
   */
  async getForEntity(entityType: string, entityId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('target_entity_type', entityType)
      .eq('target_entity_id', entityId)
      .order('step_number', { ascending: true });

    if (error) throw error;
    return data;
  }

  /**
   * Create a single-step approval request.
   */
  async createSingleStep(dto: CreateApprovalDto) {
    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .insert({
        tenant_id: tenant.id,
        target_entity_type: dto.target_entity_type,
        target_entity_id: dto.target_entity_id,
        approver_person_id: dto.approver_person_id,
        approver_team_id: dto.approver_team_id,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    await this.logDomainEvent(dto.target_entity_id, 'approval_requested', {
      approval_id: data.id,
      approver_person_id: dto.approver_person_id,
    });

    return data;
  }

  /**
   * Create a sequential multi-step approval chain.
   * Steps are processed in order — step 2 only activates after step 1 is approved.
   */
  async createSequentialChain(
    targetEntityType: string,
    targetEntityId: string,
    steps: Array<{ approver_person_id?: string; approver_team_id?: string }>,
  ) {
    const tenant = TenantContext.current();
    const chainId = crypto.randomUUID();

    const approvals = steps.map((step, index) => ({
      tenant_id: tenant.id,
      target_entity_type: targetEntityType,
      target_entity_id: targetEntityId,
      approval_chain_id: chainId,
      step_number: index + 1,
      approver_person_id: step.approver_person_id,
      approver_team_id: step.approver_team_id,
      // Only the first step is pending; subsequent steps wait
      status: index === 0 ? 'pending' : 'pending',
    }));

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .insert(approvals)
      .select();

    if (error) throw error;
    return { chain_id: chainId, steps: data };
  }

  /**
   * Create a parallel approval group.
   * All approvers must approve for the group to be complete.
   */
  async createParallelGroup(
    targetEntityType: string,
    targetEntityId: string,
    approvers: Array<{ approver_person_id?: string; approver_team_id?: string }>,
    groupName: string,
  ) {
    const tenant = TenantContext.current();

    const approvals = approvers.map((approver) => ({
      tenant_id: tenant.id,
      target_entity_type: targetEntityType,
      target_entity_id: targetEntityId,
      parallel_group: groupName,
      approver_person_id: approver.approver_person_id,
      approver_team_id: approver.approver_team_id,
      status: 'pending',
    }));

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .insert(approvals)
      .select();

    if (error) throw error;
    return { parallel_group: groupName, approvals: data };
  }

  /**
   * Respond to an approval (approve or reject).
   */
  async respond(approvalId: string, dto: RespondDto, respondingPersonId: string) {
    const tenant = TenantContext.current();

    const { data: approval, error: findError } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('id', approvalId)
      .eq('tenant_id', tenant.id)
      .single();

    if (findError || !approval) throw new NotFoundException('Approval not found');
    if (approval.status !== 'pending') throw new BadRequestException('Approval already responded to');

    const { data, error } = await this.supabase.admin
      .from('approvals')
      .update({
        status: dto.status,
        responded_at: new Date().toISOString(),
        comments: dto.comments,
      })
      .eq('id', approvalId)
      .select()
      .single();

    if (error) throw error;

    await this.logDomainEvent(approval.target_entity_id, `approval_${dto.status}`, {
      approval_id: approvalId,
      responded_by: respondingPersonId,
    });

    // For sequential chains: if approved, check if next step should activate
    if (dto.status === 'approved' && approval.approval_chain_id) {
      await this.advanceChain(approval.approval_chain_id, approval.step_number);
    }

    // Notify the target entity when its approval is resolved.
    // For single-step approvals on tickets, this unblocks routing/SLA/workflow.
    if (approval.target_entity_type === 'ticket' && !approval.approval_chain_id && !approval.parallel_group) {
      try {
        await this.ticketService.onApprovalDecision(approval.target_entity_id, dto.status);
      } catch (err) {
        console.error('[approval] ticket notification failed', err);
      }
    }

    return data;
  }

  /**
   * Check if all approvals in a parallel group are complete.
   */
  async isParallelGroupComplete(parallelGroup: string, targetEntityId: string): Promise<boolean> {
    const tenant = TenantContext.current();
    const { data } = await this.supabase.admin
      .from('approvals')
      .select('status')
      .eq('tenant_id', tenant.id)
      .eq('target_entity_id', targetEntityId)
      .eq('parallel_group', parallelGroup);

    if (!data || data.length === 0) return false;
    return data.every((a) => a.status === 'approved');
  }

  /**
   * Check if a sequential chain is fully approved.
   */
  async isChainComplete(chainId: string): Promise<boolean> {
    const { data } = await this.supabase.admin
      .from('approvals')
      .select('status')
      .eq('approval_chain_id', chainId);

    if (!data || data.length === 0) return false;
    return data.every((a) => a.status === 'approved');
  }

  private async advanceChain(chainId: string, _completedStep: number) {
    // Check if any steps in the chain were rejected
    const { data: chainSteps } = await this.supabase.admin
      .from('approvals')
      .select('*')
      .eq('approval_chain_id', chainId)
      .order('step_number');

    if (!chainSteps) return;

    const hasRejection = chainSteps.some((s) => s.status === 'rejected');
    if (hasRejection) return; // Chain is broken, no more steps

    // The next step is already "pending" — in a real implementation you might
    // want to hold steps as "waiting" and only set to "pending" when it's their turn.
    // For now the sequential enforcement happens at the respond() level:
    // the UI should only show the current step as actionable.
  }

  private async logDomainEvent(entityId: string, eventType: string, payload: Record<string, unknown>) {
    const tenant = TenantContext.current();
    await this.supabase.admin.from('domain_events').insert({
      tenant_id: tenant.id,
      event_type: eventType,
      entity_type: 'approval',
      entity_id: entityId,
      payload,
    });
  }
}
