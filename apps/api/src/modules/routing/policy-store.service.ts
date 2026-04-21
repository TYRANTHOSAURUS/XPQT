import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  parsePolicyDefinition,
  ROUTING_STUDIO_SCHEMAS,
  type RoutingStudioConfigType,
} from '@prequest/shared';
import { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * Workstream A / task WA-2: config-engine-backed storage for the four
 * routing-studio policy types (case_owner_policy, child_dispatch_policy,
 * domain_registry, space_levels).
 *
 * Why this wraps the existing config_entities + config_versions tables
 * rather than adding dedicated policy tables:
 *   - draft/publish/archive lifecycle is already solved (migration 00007)
 *   - audit, diff, rollback come free
 *   - one mental model across all platform config (request types, workflows,
 *     SLA policies, routing policies, …)
 *
 * Every mutation validates the payload via the shared zod schemas before
 * touching the database. Bad payloads fail with 400, not with a jsonb
 * constraint later.
 */

interface CreateEntityInput {
  tenant_id: string;
  config_type: RoutingStudioConfigType;
  slug: string;
  display_name: string;
}

interface CreateDraftVersionInput {
  tenant_id: string;
  entity_id: string;
  definition: unknown;
  created_by?: string | null;
}

interface PublishVersionInput {
  tenant_id: string;
  version_id: string;
  published_by?: string | null;
}

export interface PolicyEntityRow {
  id: string;
  tenant_id: string;
  config_type: RoutingStudioConfigType;
  slug: string;
  display_name: string;
  current_published_version_id: string | null;
  status: 'active' | 'archived';
}

export interface PolicyVersionRow {
  id: string;
  config_entity_id: string;
  tenant_id: string;
  version_number: number;
  status: 'draft' | 'published' | 'archived';
  definition: unknown;
  published_at: string | null;
}

@Injectable()
export class PolicyStoreService {
  constructor(private readonly supabase: SupabaseService) {}

  private assertRoutingStudioType(config_type: string): asserts config_type is RoutingStudioConfigType {
    if (!(config_type in ROUTING_STUDIO_SCHEMAS)) {
      throw new BadRequestException(
        `config_type "${config_type}" is not a routing-studio policy type`,
      );
    }
  }

  async createEntity(input: CreateEntityInput): Promise<PolicyEntityRow> {
    this.assertRoutingStudioType(input.config_type);

    const { data, error } = await this.supabase.admin
      .from('config_entities')
      .insert({
        tenant_id: input.tenant_id,
        config_type: input.config_type,
        slug: input.slug,
        display_name: input.display_name,
      })
      .select('*')
      .single();

    if (error) {
      // (tenant_id, config_type, slug) unique — duplicate slug is user error.
      if (error.code === '23505') {
        throw new BadRequestException(
          `config entity with slug "${input.slug}" already exists for ${input.config_type}`,
        );
      }
      throw new BadRequestException(`failed to create config entity: ${error.message}`);
    }
    return data as PolicyEntityRow;
  }

  async getEntity(tenant_id: string, entity_id: string): Promise<PolicyEntityRow> {
    const { data, error } = await this.supabase.admin
      .from('config_entities')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('id', entity_id)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException(`config entity ${entity_id} not found`);
    return data as PolicyEntityRow;
  }

  async createDraftVersion(input: CreateDraftVersionInput): Promise<PolicyVersionRow> {
    const entity = await this.getEntity(input.tenant_id, input.entity_id);
    this.assertRoutingStudioType(entity.config_type);

    // Throws 400 with the zod issue trail if the payload is malformed —
    // better to reject here than to persist junk into jsonb.
    try {
      parsePolicyDefinition(entity.config_type, input.definition);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid definition';
      throw new BadRequestException(`definition failed validation: ${msg}`);
    }

    const nextVersionNumber = await this.nextVersionNumber(input.entity_id);

    const { data, error } = await this.supabase.admin
      .from('config_versions')
      .insert({
        config_entity_id: input.entity_id,
        tenant_id: input.tenant_id,
        version_number: nextVersionNumber,
        status: 'draft',
        definition: input.definition,
        created_by: input.created_by ?? null,
      })
      .select('*')
      .single();

    if (error) throw new BadRequestException(`failed to create draft version: ${error.message}`);
    return data as PolicyVersionRow;
  }

  async publishVersion(input: PublishVersionInput): Promise<PolicyVersionRow> {
    // Fetch version + entity to validate state and re-check definition.
    const { data: version, error: verErr } = await this.supabase.admin
      .from('config_versions')
      .select('*')
      .eq('tenant_id', input.tenant_id)
      .eq('id', input.version_id)
      .maybeSingle();

    if (verErr) throw new BadRequestException(verErr.message);
    if (!version) throw new NotFoundException(`config version ${input.version_id} not found`);
    const ver = version as PolicyVersionRow;
    if (ver.status !== 'draft') {
      throw new BadRequestException(
        `version ${input.version_id} is ${ver.status}, only draft versions can be published`,
      );
    }

    const entity = await this.getEntity(input.tenant_id, ver.config_entity_id);
    this.assertRoutingStudioType(entity.config_type);

    // Re-validate right before publish so a schema migration between draft and
    // publish can't sneak through.
    try {
      parsePolicyDefinition(entity.config_type, ver.definition);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid definition';
      throw new BadRequestException(`cannot publish — definition is invalid: ${msg}`);
    }

    // Archive any previously published version for this entity. Then mark this
    // one published and point the entity at it. Three writes; Supabase's
    // postgrest has no transactions over the JS client — the worst-case
    // partial state is (old published, new published, pointer still old)
    // which self-heals on the next publish and reads still resolve correctly
    // via current_published_version_id.
    if (entity.current_published_version_id && entity.current_published_version_id !== ver.id) {
      await this.supabase.admin
        .from('config_versions')
        .update({ status: 'archived' })
        .eq('tenant_id', input.tenant_id)
        .eq('id', entity.current_published_version_id);
    }

    const nowIso = new Date().toISOString();
    const { data: published, error: pubErr } = await this.supabase.admin
      .from('config_versions')
      .update({
        status: 'published',
        published_at: nowIso,
        published_by: input.published_by ?? null,
      })
      .eq('tenant_id', input.tenant_id)
      .eq('id', ver.id)
      .select('*')
      .single();

    if (pubErr) throw new BadRequestException(`failed to publish version: ${pubErr.message}`);

    const { error: entErr } = await this.supabase.admin
      .from('config_entities')
      .update({ current_published_version_id: ver.id })
      .eq('tenant_id', input.tenant_id)
      .eq('id', entity.id);

    if (entErr) throw new BadRequestException(`failed to point entity at published version: ${entErr.message}`);

    return published as PolicyVersionRow;
  }

  /**
   * Returns the validated, parsed definition of the entity's currently
   * published version. Used by downstream engines (case-owner, child-dispatch)
   * at ticket-create time.
   */
  async getPublishedDefinition<T extends RoutingStudioConfigType>(
    tenant_id: string,
    entity_id: string,
  ): Promise<{ config_type: T; definition: unknown; version_id: string } | null> {
    const entity = await this.getEntity(tenant_id, entity_id);
    if (!entity.current_published_version_id) return null;
    this.assertRoutingStudioType(entity.config_type);

    const { data, error } = await this.supabase.admin
      .from('config_versions')
      .select('id, definition')
      .eq('tenant_id', tenant_id)
      .eq('id', entity.current_published_version_id)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) return null;

    const parsed = parsePolicyDefinition(entity.config_type, data.definition);
    return {
      config_type: entity.config_type as T,
      definition: parsed,
      version_id: data.id as string,
    };
  }

  async listEntities(
    tenant_id: string,
    config_type: RoutingStudioConfigType,
  ): Promise<PolicyEntityRow[]> {
    this.assertRoutingStudioType(config_type);
    const { data, error } = await this.supabase.admin
      .from('config_entities')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('config_type', config_type)
      .eq('status', 'active')
      .order('display_name', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as PolicyEntityRow[];
  }

  private async nextVersionNumber(entity_id: string): Promise<number> {
    const { data, error } = await this.supabase.admin
      .from('config_versions')
      .select('version_number')
      .eq('config_entity_id', entity_id)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return (data?.version_number ?? 0) + 1;
  }
}
