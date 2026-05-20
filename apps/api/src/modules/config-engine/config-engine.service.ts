import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors, wrapPgError } from '../../common/errors';
import { assertTenantOwned } from '../../common/tenant-validation';

export interface CreateConfigEntityDto {
  config_type: string;
  slug: string;
  display_name: string;
  definition: Record<string, unknown>;
}

export interface UpdateConfigVersionDto {
  definition: Record<string, unknown>;
}

@Injectable()
export class ConfigEngineService {
  constructor(private readonly supabase: SupabaseService) {}

  async listByType(configType: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('config_entities')
      .select('*, current_version:config_versions!fk_ce_published_version(*)')
      .eq('tenant_id', tenant.id)
      .eq('config_type', configType)
      .order('display_name');

    if (error) {
      throw wrapPgError(error, 'config_engine.entity_list_failed', {
        detail: `Config entities list failed for type ${configType}`,
      });
    }
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('config_entities')
      .select('*, current_version:config_versions!fk_ce_published_version(*), versions:config_versions!config_versions_config_entity_id_fkey(*)')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) throw AppErrors.notFoundWithCode('config_engine.entity_not_found', 'Config entity not found');
    return data;
  }

  async create(dto: CreateConfigEntityDto) {
    const tenant = TenantContext.current();

    // Create the entity
    const { data: entity, error: entityError } = await this.supabase.admin
      .from('config_entities')
      .insert({
        tenant_id: tenant.id,
        config_type: dto.config_type,
        slug: dto.slug,
        display_name: dto.display_name,
      })
      .select()
      .single();

    if (entityError) {
      throw wrapPgError(entityError, 'config_engine.entity_create_failed', {
        detail: `Config entity insert failed (type ${dto.config_type})`,
      });
    }

    // Create the first version as draft
    const { data: version, error: versionError } = await this.supabase.admin
      .from('config_versions')
      .insert({
        config_entity_id: entity.id,
        tenant_id: tenant.id,
        version_number: 1,
        status: 'draft',
        definition: dto.definition,
      })
      .select()
      .single();

    if (versionError) {
      throw wrapPgError(versionError, 'config_engine.draft_create_failed', {
        detail: `Initial draft version insert failed for entity ${entity.id}`,
      });
    }

    return { ...entity, draft_version: version };
  }

  async createDraft(entityId: string, dto: UpdateConfigVersionDto) {
    const tenant = TenantContext.current();

    // Cross-tenant write fix (codex post-fix review 2026-05-08): the prior
    // shape SELECTed `latest` filtered by entityId+tenant, then INSERTed a
    // new config_versions row with `config_entity_id=entityId,
    // tenant_id=tenant.id`. supabase.admin bypasses RLS and the parent FK
    // exists globally, so a foreign entityId would silently land an
    // attacker-owned draft on a victim tenant's entity. Pre-flight assert
    // the entity is in this tenant.
    await assertTenantOwned(this.supabase, 'config_entities', entityId, tenant.id, {
      entityName: 'config_entity',
    });

    // Find the latest version to determine the next version number
    const { data: latest } = await this.supabase.admin
      .from('config_versions')
      .select('version_number')
      .eq('config_entity_id', entityId)
      .eq('tenant_id', tenant.id)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    const nextVersion = (latest?.version_number ?? 0) + 1;

    const { data, error } = await this.supabase.admin
      .from('config_versions')
      .insert({
        config_entity_id: entityId,
        tenant_id: tenant.id,
        version_number: nextVersion,
        status: 'draft',
        definition: dto.definition,
      })
      .select()
      .single();

    if (error) {
      throw wrapPgError(error, 'config_engine.draft_create_failed', {
        detail: `Draft version insert failed for entity ${entityId}`,
      });
    }
    return data;
  }

  async updateDraft(entityId: string, dto: UpdateConfigVersionDto) {
    const tenant = TenantContext.current();

    // Find the current draft version
    const { data: draft, error: findError } = await this.supabase.admin
      .from('config_versions')
      .select('*')
      .eq('config_entity_id', entityId)
      .eq('tenant_id', tenant.id)
      .eq('status', 'draft')
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (findError || !draft) throw AppErrors.notFoundWithCode('config_engine.draft_not_found', 'No draft version found');

    const { data, error } = await this.supabase.admin
      .from('config_versions')
      .update({ definition: dto.definition })
      .eq('id', draft.id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) {
      throw wrapPgError(error, 'config_engine.draft_update_failed', {
        detail: `Draft update failed for entity ${entityId}`,
      });
    }
    return data;
  }

  async publish(entityId: string) {
    const tenant = TenantContext.current();

    // Find the latest draft
    const { data: draft, error: findError } = await this.supabase.admin
      .from('config_versions')
      .select('*')
      .eq('config_entity_id', entityId)
      .eq('tenant_id', tenant.id)
      .eq('status', 'draft')
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (findError || !draft) throw AppErrors.validationFailed('config_engine.no_draft_to_publish', { detail: 'No draft version to publish' });

    // Mark as published. Tenant filter is defense-in-depth — draft.id was
    // resolved from a tenant-filtered SELECT above.
    const { error: publishError } = await this.supabase.admin
      .from('config_versions')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', draft.id)
      .eq('tenant_id', tenant.id);

    if (publishError) {
      throw wrapPgError(publishError, 'config_engine.publish_failed', {
        detail: `Config version ${draft.id} publish status update failed`,
      });
    }

    // Update entity to point to this version. Codex post-fix review 2026-05-08:
    // entityId came in via path param; without tenant filter, supabase.admin
    // bypasses RLS and a foreign entityId could be flipped to point at this
    // tenant's draft. .eq('tenant_id', tenant.id) closes that. The draft.id
    // load above is also tenant-scoped, but defense-in-depth on the write.
    const { error: updateError } = await this.supabase.admin
      .from('config_entities')
      .update({ current_published_version_id: draft.id })
      .eq('id', entityId)
      .eq('tenant_id', tenant.id);

    if (updateError) {
      throw wrapPgError(updateError, 'config_engine.publish_pointer_failed', {
        detail: `Config entity ${entityId} published-pointer update failed`,
      });
    }

    // Log audit event
    await this.supabase.admin.from('audit_events').insert({
      tenant_id: tenant.id,
      event_type: 'config_published',
      entity_type: 'config_entity',
      entity_id: entityId,
      details: { version_number: draft.version_number, config_entity_id: entityId },
    });

    return { published: true, version_number: draft.version_number };
  }

  async rollback(entityId: string, targetVersionId: string) {
    const tenant = TenantContext.current();

    const { data: version, error } = await this.supabase.admin
      .from('config_versions')
      .select('*')
      .eq('id', targetVersionId)
      .eq('config_entity_id', entityId)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !version) throw AppErrors.notFoundWithCode('config_engine.version_not_found', 'Version not found');

    // Update entity to point to the target version. Tenant filter:
    // defense-in-depth (codex post-fix review 2026-05-08).
    await this.supabase.admin
      .from('config_entities')
      .update({ current_published_version_id: targetVersionId })
      .eq('id', entityId)
      .eq('tenant_id', tenant.id);

    await this.supabase.admin.from('audit_events').insert({
      tenant_id: tenant.id,
      event_type: 'config_rollback',
      entity_type: 'config_entity',
      entity_id: entityId,
      details: { rolled_back_to_version: version.version_number },
    });

    return { rolled_back_to: version.version_number };
  }
}
