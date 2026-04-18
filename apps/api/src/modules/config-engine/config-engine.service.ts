import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

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

    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('config_entities')
      .select('*, current_version:config_versions!fk_ce_published_version(*), versions:config_versions(*)')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) throw new NotFoundException('Config entity not found');
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

    if (entityError) throw entityError;

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

    if (versionError) throw versionError;

    return { ...entity, draft_version: version };
  }

  async createDraft(entityId: string, dto: UpdateConfigVersionDto) {
    const tenant = TenantContext.current();

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

    if (error) throw error;
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

    if (findError || !draft) throw new NotFoundException('No draft version found');

    const { data, error } = await this.supabase.admin
      .from('config_versions')
      .update({ definition: dto.definition })
      .eq('id', draft.id)
      .select()
      .single();

    if (error) throw error;
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

    if (findError || !draft) throw new BadRequestException('No draft version to publish');

    // Mark as published
    const { error: publishError } = await this.supabase.admin
      .from('config_versions')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', draft.id);

    if (publishError) throw publishError;

    // Update entity to point to this version
    const { error: updateError } = await this.supabase.admin
      .from('config_entities')
      .update({ current_published_version_id: draft.id })
      .eq('id', entityId);

    if (updateError) throw updateError;

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

    if (error || !version) throw new NotFoundException('Version not found');

    // Update entity to point to the target version
    await this.supabase.admin
      .from('config_entities')
      .update({ current_published_version_id: targetVersionId })
      .eq('id', entityId);

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
