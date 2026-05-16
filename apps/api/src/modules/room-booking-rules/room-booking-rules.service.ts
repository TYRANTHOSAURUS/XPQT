import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors } from '../../common/errors';
import { PredicateEngineService } from './predicate-engine.service';
import { getTemplate } from './rule-templates';
import { ApprovalConfigCompilerService } from '../approval/approval-config-compiler.service';
import type {
  ApprovalConfig,
  ChangeType,
  CreateRuleDto,
  FromTemplateDto,
  RuleListFilters,
  UpdateRuleDto,
} from './dto';

/**
 * CRUD + version history for `room_booking_rules`.
 *
 * Versioning model: every save (create / update / soft-delete / enable /
 * disable) writes one row to `room_booking_rule_versions` with `version_number`
 * = max(version_number)+1, the full snapshot, and a diff vs prior version. The
 * service is the single source of truth for version emission — DB triggers
 * would lose the actor info we want in the audit feed. Version inserts go via
 * the admin client (the table's INSERT policy is locked to service role only).
 *
 * Soft delete sets `active=false` and writes a `change_type='delete'` version
 * row. The actual row stays in the table so versions and references remain
 * intact. Hard delete is intentionally not exposed here.
 */

const VERSIONABLE_FIELDS: Array<keyof RuleSnapshot> = [
  'name',
  'description',
  'target_scope',
  'target_id',
  'applies_when',
  'effect',
  'approval_config',
  'denial_message',
  'priority',
  'template_id',
  'template_params',
  'active',
];

interface RuleSnapshot {
  name: string;
  description: string | null;
  target_scope: string;
  target_id: string | null;
  applies_when: unknown;
  effect: string;
  approval_config: unknown;
  denial_message: string | null;
  priority: number;
  template_id: string | null;
  template_params: unknown;
  active: boolean;
}

@Injectable()
export class RoomBookingRulesService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly engine: PredicateEngineService,
    // Phase 1.5 sub-step 6.E: pure-TS compiler from 6.A.X used to mint a
    // workflow_definition for every rule with non-null approval_config.
    // Persistence is the `ensure_room_booking_rule_workflow_definition`
    // RPC's job (BLOCKER 1 closure — atomic version bump + INSERT +
    // archive + FK flip under one row lock). Compiler is pure compile-only.
    private readonly approvalCompiler: ApprovalConfigCompilerService,
  ) {}

  /**
   * Phase 1.5 (Universal Workflow Architecture) — compile the approval
   * graph for a rule whose `approval_config` is non-null. Pure compile
   * only: persistence (rule INSERT/UPDATE + workflow_definition mint +
   * FK flip) is the consolidating PL/pgSQL RPCs' job
   * (`create_room_booking_rule_with_workflow` /
   * `update_room_booking_rule_with_workflow`, migration
   * 00406_room_booking_rule_with_workflow_rpcs.sql), which do all writes
   * in ONE transaction. There is no longer an INSERT-then-recompile
   * window, so no TS-side compensation.
   *
   * Returns the compiled graph_definition (to hand to the create RPC)
   * or `null` when `approval_config` is null (the "rule doesn't require
   * approval" case — the RPC then skips the workflow_definition mint and
   * leaves `workflow_definition_id` NULL; runtime falls back to the
   * legacy createApprovalRows path which itself no-ops when there's
   * nothing to approve).
   *
   * The compiler throws `workflow_definition.compilation_failed` (422)
   * on a malformed approval_config; let it propagate verbatim — it's
   * already the right error code for the caller.
   */
  private compileApprovalGraph(
    ruleName: string,
    approvalConfig: ApprovalConfig | null,
  ): unknown | null {
    if (!approvalConfig) return null;
    const compiled = this.approvalCompiler.compile(approvalConfig, {
      ruleName,
      ruleType: 'room_booking',
    });
    return compiled.graphDefinition;
  }

  async list(filters: RuleListFilters = {}) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('room_booking_rules')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('priority', { ascending: false })
      .order('name');

    if (filters.target_scope) query = query.eq('target_scope', filters.target_scope);
    if (filters.target_id !== undefined && filters.target_id !== null) {
      query = query.eq('target_id', filters.target_id);
    }
    if (filters.active !== undefined) query = query.eq('active', filters.active);
    if (filters.effect) query = query.eq('effect', filters.effect);

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async findOne(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('room_booking_rules')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw AppErrors.notFoundWithCode('room_rule.not_found', `Rule ${id} not found`);
    return data;
  }

  async create(dto: CreateRuleDto, actorUserId: string | null) {
    const tenant = TenantContext.current();
    this.validateCreateInput(dto);

    // Phase 1.5 (Universal Workflow Architecture): the rule INSERT +
    // workflow_definition mint + FK flip are now ONE transaction in the
    // `create_room_booking_rule_with_workflow` PL/pgSQL RPC (migration
    // 00406_room_booking_rule_with_workflow_rpcs.sql). This replaces the
    // legacy INSERT-then-recompile-then-TS-compensate path (commit
    // 2a5f1af3): there is no partial-write window, so the
    // delete-the-rule-on-recompile-failure block is gone.
    const ruleData: Record<string, unknown> = {
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      target_scope: dto.target_scope,
      target_id: dto.target_id ?? null,
      applies_when: dto.applies_when,
      effect: dto.effect,
      approval_config: dto.approval_config ?? null,
      denial_message: dto.denial_message?.trim() || null,
      priority: dto.priority ?? 100,
      template_id: dto.template_id ?? null,
      template_params: dto.template_params ?? null,
      active: dto.active ?? true,
    };

    // Compile the approval graph before the write (the compiler throws
    // `workflow_definition.compilation_failed` (422) on a malformed
    // config — surface that to the caller before touching the DB). NULL
    // when the rule has no approval_config: the RPC then skips the
    // workflow_definition mint and leaves workflow_definition_id NULL.
    const graphDefinition = this.compileApprovalGraph(
      dto.name.trim(),
      (dto.approval_config ?? null) as ApprovalConfig | null,
    );

    const { data, error } = await this.supabase.admin.rpc(
      'create_room_booking_rule_with_workflow',
      {
        p_tenant_id: tenant.id,
        p_rule_data: ruleData,
        p_graph_definition: graphDefinition,
        p_actor_user_id: actorUserId,
      },
    );
    if (error) {
      // RPC-layer failure (P0001 bad input, P0002 not found, DB wobble,
      // cross-tenant FK trigger). Server-class so the FE shows a
      // "couldn't save the rule" toast rather than a validation banner.
      throw AppErrors.server('room_rule.workflow_recompile_failed', {
        detail: `create_room_booking_rule_with_workflow RPC failed: ${error.message}`,
      });
    }
    const result = (data ?? null) as { rule: Record<string, unknown> } | null;
    if (!result?.rule) {
      throw AppErrors.server('room_rule.workflow_recompile_failed', {
        detail: 'create_room_booking_rule_with_workflow RPC returned no rule',
      });
    }
    const rule = result.rule;

    await this.writeVersion(
      rule.id as string,
      tenant.id,
      'create',
      null,
      rule,
      actorUserId,
    );
    await this.emitAudit('room_booking_rule.created', rule.id as string, {
      name: rule.name,
      effect: rule.effect,
      target_scope: rule.target_scope,
    });
    return rule;
  }

  async update(id: string, patch: UpdateRuleDto, actorUserId: string | null) {
    const tenant = TenantContext.current();
    const before = await this.findOne(id);
    if (patch.applies_when !== undefined) this.engine.validate(patch.applies_when);
    if (patch.effect && !VALID_EFFECTS.has(patch.effect)) {
      throw AppErrors.validationFailed('room_rule.invalid_effect', { detail: `unknown effect: ${patch.effect}` });
    }

    // Build the sparse patch — ONLY keys present in the DTO are sent; the
    // RPC keeps every absent column at its current value (CLAUDE.md
    // "multi-step writes are RPCs": the UPDATE + recompile are one tx in
    // `update_room_booking_rule_with_workflow`, migration 00406).
    const rulePatch: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw AppErrors.validationFailed('room_rule.name_required', { detail: 'name cannot be empty' });
      rulePatch.name = trimmed;
    }
    if (patch.description !== undefined) rulePatch.description = patch.description?.trim() || null;
    if (patch.target_scope !== undefined) rulePatch.target_scope = patch.target_scope;
    if (patch.target_id !== undefined) rulePatch.target_id = patch.target_id;
    if (patch.applies_when !== undefined) rulePatch.applies_when = patch.applies_when;
    if (patch.effect !== undefined) rulePatch.effect = patch.effect;
    if (patch.approval_config !== undefined) rulePatch.approval_config = patch.approval_config;
    if (patch.denial_message !== undefined) rulePatch.denial_message = patch.denial_message?.trim() || null;
    if (patch.priority !== undefined) rulePatch.priority = patch.priority;
    if (patch.template_id !== undefined) rulePatch.template_id = patch.template_id;
    if (patch.template_params !== undefined) rulePatch.template_params = patch.template_params;
    if (patch.active !== undefined) rulePatch.active = patch.active;

    // Recompile iff approval_config was in the patch OR the rule's name
    // changed (the rule name is the workflow_definitions.name suffix).
    // The RPC additionally no-ops the recompile when the rule has no
    // approval_config — but compute the flag here to mirror prior
    // behaviour exactly (changing effect/applies_when does NOT recompile;
    // the graph shape derives solely from approval_config).
    const recompile = patch.approval_config !== undefined || patch.name !== undefined;

    const { data, error } = await this.supabase.admin.rpc(
      'update_room_booking_rule_with_workflow',
      {
        p_tenant_id: tenant.id,
        p_rule_id: id,
        p_patch: rulePatch,
        p_recompile: recompile,
        p_actor_user_id: actorUserId,
      },
    );
    if (error) {
      throw AppErrors.server('room_rule.workflow_recompile_failed', {
        detail: `update_room_booking_rule_with_workflow RPC failed: ${error.message}`,
      });
    }
    const result = (data ?? null) as { rule: Record<string, unknown> } | null;
    if (!result?.rule) {
      throw AppErrors.notFoundWithCode('room_rule.not_found', `Rule ${id} not found`);
    }
    const rule = result.rule;

    const changeType: ChangeType =
      patch.active === false && before.active
        ? 'disable'
        : patch.active === true && !before.active
          ? 'enable'
          : 'update';
    await this.writeVersion(id, tenant.id, changeType, before, rule, actorUserId);
    await this.emitAudit(`room_booking_rule.${changeType}`, id, {
      name: rule.name,
      effect: rule.effect,
    });
    return rule;
  }

  async softDelete(id: string, actorUserId: string | null) {
    const tenant = TenantContext.current();
    const before = await this.findOne(id);
    const { data, error } = await this.supabase.admin
      .from('room_booking_rules')
      .update({ active: false, updated_at: new Date().toISOString(), updated_by: actorUserId })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw error;

    await this.writeVersion(id, tenant.id, 'delete', before, data, actorUserId);
    await this.emitAudit('room_booking_rule.deleted', id, { name: before.name });
    return data;
  }

  async versions(ruleId: string) {
    const tenant = TenantContext.current();
    // Confirm rule belongs to tenant before listing.
    await this.findOne(ruleId);
    const { data, error } = await this.supabase.admin
      .from('room_booking_rule_versions')
      .select('*')
      .eq('rule_id', ruleId)
      .eq('tenant_id', tenant.id)
      .order('version_number', { ascending: false });
    if (error) throw error;
    return data ?? [];
  }

  async restoreVersion(id: string, versionNumber: number, actorUserId: string | null) {
    const tenant = TenantContext.current();
    await this.findOne(id);
    const { data: version, error } = await this.supabase.admin
      .from('room_booking_rule_versions')
      .select('*')
      .eq('rule_id', id)
      .eq('tenant_id', tenant.id)
      .eq('version_number', versionNumber)
      .maybeSingle();
    if (error) throw error;
    if (!version) throw AppErrors.notFoundWithCode('room_rule.version_not_found', `Version ${versionNumber} not found`);

    const snap = (version as { snapshot: RuleSnapshot }).snapshot;
    return this.update(
      id,
      {
        name: snap.name,
        description: snap.description,
        target_scope: snap.target_scope as CreateRuleDto['target_scope'],
        target_id: snap.target_id,
        applies_when: snap.applies_when as CreateRuleDto['applies_when'],
        effect: snap.effect as CreateRuleDto['effect'],
        approval_config: snap.approval_config as CreateRuleDto['approval_config'],
        denial_message: snap.denial_message,
        priority: snap.priority,
        template_id: snap.template_id,
        template_params: snap.template_params as CreateRuleDto['template_params'],
        active: snap.active,
      },
      actorUserId,
    );
  }

  async createFromTemplate(dto: FromTemplateDto, actorUserId: string | null) {
    const template = getTemplate(dto.template_id);
    const compiled = template.compile(dto.params ?? {});
    return this.create(
      {
        name: dto.name?.trim() || compiled.suggested_name || template.label,
        description: dto.description ?? template.description,
        target_scope: dto.target_scope,
        target_id: dto.target_id ?? null,
        applies_when: compiled.applies_when,
        effect: compiled.effect,
        approval_config: compiled.approval_config ?? null,
        denial_message: compiled.denial_message ?? null,
        priority: dto.priority ?? 100,
        template_id: template.id,
        template_params: dto.params ?? {},
        active: dto.active ?? true,
      },
      actorUserId,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private validateCreateInput(dto: CreateRuleDto) {
    if (!dto.name?.trim()) throw AppErrors.validationFailed('room_rule.name_required', { detail: 'name is required' });
    if (!VALID_TARGET_SCOPES.has(dto.target_scope)) {
      throw AppErrors.validationFailed('room_rule.invalid_scope', { detail: `unknown target_scope: ${dto.target_scope}` });
    }
    if (!VALID_EFFECTS.has(dto.effect)) {
      throw AppErrors.validationFailed('room_rule.invalid_effect', { detail: `unknown effect: ${dto.effect}` });
    }
    if (dto.target_scope === 'tenant' && dto.target_id) {
      throw AppErrors.validationFailed('room_rule.invalid_scope', { detail: 'tenant scope must not have target_id' });
    }
    if (dto.target_scope !== 'tenant' && !dto.target_id && dto.target_scope !== 'room_type') {
      // room_type is allowed to have null target_id (= type-agnostic; the
      // applies_when does the typing).
      throw AppErrors.validationFailed('room_rule.invalid_scope', { detail: `${dto.target_scope} scope requires target_id` });
    }
    this.engine.validate(dto.applies_when);
  }

  private async writeVersion(
    ruleId: string,
    tenantId: string,
    changeType: ChangeType,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    actorUserId: string | null,
  ) {
    const { data: latest } = await this.supabase.admin
      .from('room_booking_rule_versions')
      .select('version_number')
      .eq('rule_id', ruleId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const next = ((latest as { version_number?: number } | null)?.version_number ?? 0) + 1;

    const diff = before ? buildDiff(before, after) : null;
    const snapshot = pickSnapshotFields(after);

    // Insert via service-role admin client; the INSERT policy on the version
    // table denies authenticated callers.
    const { error } = await this.supabase.admin.from('room_booking_rule_versions').insert({
      rule_id: ruleId,
      tenant_id: tenantId,
      version_number: next,
      change_type: changeType,
      snapshot,
      diff,
      actor_user_id: actorUserId,
    });
    if (error) {
      // Don't fail the user-facing request if version emission fails — log
      // and move on. Same pattern as branding.service.ts audit.
      console.warn('[room_booking_rule_versions] write failed', error.message);
    }
  }

  private async emitAudit(
    eventType: string,
    ruleId: string,
    details: Record<string, unknown>,
  ) {
    const tenant = TenantContext.current();
    try {
      const { error } = await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenant.id,
        event_type: eventType,
        entity_type: 'room_booking_rule',
        entity_id: ruleId,
        details,
      });
      if (error) console.warn('[audit] room_booking_rule emit failed', error.message);
    } catch (err) {
      console.warn('[audit] room_booking_rule emit threw', err);
    }
  }
}

const VALID_TARGET_SCOPES = new Set(['room', 'room_type', 'space_subtree', 'tenant']);
const VALID_EFFECTS = new Set(['deny', 'require_approval', 'allow_override', 'warn']);

export function pickSnapshotFields(row: Record<string, unknown>): RuleSnapshot {
  const out = {} as Record<string, unknown>;
  for (const k of VERSIONABLE_FIELDS) {
    out[k] = row[k];
  }
  return out as unknown as RuleSnapshot;
}

export function buildDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of VERSIONABLE_FIELDS) {
    const b = before[k];
    const a = after[k];
    // Use JSON equality for objects/arrays — predicates often nest.
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff[k] = { before: b, after: a };
    }
  }
  return diff;
}
