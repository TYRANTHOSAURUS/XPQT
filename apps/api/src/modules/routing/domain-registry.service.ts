import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * Workstream A / task WA-3: CRUD over public.domains (migration 00039).
 *
 * During dual-run, callers either look up by `key` (the canonical lowercased
 * machine key, e.g. 'it', 'fm', 'catering') or by `id`. Free-text callers
 * (request_types.domain, location_teams.domain, domain_parents.domain) will
 * continue to work until Artifact D step 9 cutover removes those columns.
 *
 * Circular parentage is guarded with a recursive walk at insert/update time —
 * a UNIQUE constraint isn't enough because A→B→C→A needs graph logic.
 */

export interface DomainRow {
  id: string;
  tenant_id: string;
  key: string;
  display_name: string;
  parent_domain_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface CreateDomainInput {
  tenant_id: string;
  key: string;
  display_name: string;
  parent_domain_id?: string | null;
}

interface UpdateDomainInput {
  tenant_id: string;
  id: string;
  display_name?: string;
  parent_domain_id?: string | null;
  active?: boolean;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_PARENT_WALK = 20;

@Injectable()
export class DomainRegistryService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(tenant_id: string): Promise<DomainRow[]> {
    const { data, error } = await this.supabase.admin
      .from('domains')
      .select('*')
      .eq('tenant_id', tenant_id)
      .order('display_name', { ascending: true });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as DomainRow[];
  }

  async get(tenant_id: string, id: string): Promise<DomainRow> {
    const { data, error } = await this.supabase.admin
      .from('domains')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException(`domain ${id} not found`);
    return data as DomainRow;
  }

  async findByKey(tenant_id: string, key: string): Promise<DomainRow | null> {
    const { data, error } = await this.supabase.admin
      .from('domains')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('key', key)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return (data as DomainRow) ?? null;
  }

  async create(input: CreateDomainInput): Promise<DomainRow> {
    const key = normalizeKey(input.key);
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException(
        `domain key "${input.key}" is invalid — must match [a-z0-9][a-z0-9_-]*`,
      );
    }
    if (input.parent_domain_id) {
      // Only check parent existence; circular detection not needed on create
      // because a newly-inserted row has no children yet.
      await this.get(input.tenant_id, input.parent_domain_id);
    }

    const { data, error } = await this.supabase.admin
      .from('domains')
      .insert({
        tenant_id: input.tenant_id,
        key,
        display_name: input.display_name,
        parent_domain_id: input.parent_domain_id ?? null,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException(`domain key "${key}" already exists for this tenant`);
      }
      throw new BadRequestException(`failed to create domain: ${error.message}`);
    }
    return data as DomainRow;
  }

  async update(input: UpdateDomainInput): Promise<DomainRow> {
    const current = await this.get(input.tenant_id, input.id);

    if (input.parent_domain_id === current.id) {
      throw new BadRequestException('a domain cannot be its own parent');
    }

    if (input.parent_domain_id && input.parent_domain_id !== current.parent_domain_id) {
      await this.assertNoCycle(input.tenant_id, input.id, input.parent_domain_id);
    }

    const patch: Partial<DomainRow> = {};
    if (input.display_name !== undefined) patch.display_name = input.display_name;
    if (input.parent_domain_id !== undefined) patch.parent_domain_id = input.parent_domain_id;
    if (input.active !== undefined) patch.active = input.active;

    if (Object.keys(patch).length === 0) return current;

    const { data, error } = await this.supabase.admin
      .from('domains')
      .update(patch)
      .eq('tenant_id', input.tenant_id)
      .eq('id', input.id)
      .select('*')
      .single();

    if (error) throw new BadRequestException(`failed to update domain: ${error.message}`);
    return data as DomainRow;
  }

  /**
   * Soft-deactivate by default — hard-delete would cascade-null every
   * request_types.domain_id / location_teams.domain_id that ever referenced
   * it, which silently breaks routing.
   */
  async deactivate(tenant_id: string, id: string): Promise<DomainRow> {
    return this.update({ tenant_id, id, active: false });
  }

  /**
   * Walks parent_domain_id up to MAX_PARENT_WALK hops to detect a cycle that
   * would form if `candidateParentId` became the parent of `domainId`.
   */
  private async assertNoCycle(
    tenant_id: string,
    domainId: string,
    candidateParentId: string,
  ): Promise<void> {
    let cursor: string | null = candidateParentId;
    for (let hop = 0; cursor && hop < MAX_PARENT_WALK; hop++) {
      if (cursor === domainId) {
        throw new BadRequestException(
          `setting parent ${candidateParentId} on domain ${domainId} would create a cycle`,
        );
      }
      const result: { data: { parent_domain_id: string | null } | null; error: { message: string } | null } =
        await this.supabase.admin
          .from('domains')
          .select('parent_domain_id')
          .eq('tenant_id', tenant_id)
          .eq('id', cursor)
          .maybeSingle();
      if (result.error) throw new BadRequestException(result.error.message);
      cursor = result.data?.parent_domain_id ?? null;
    }
    if (cursor) {
      throw new BadRequestException(
        `domain parentage chain exceeded ${MAX_PARENT_WALK} hops — likely a cycle`,
      );
    }
  }
}

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase();
}
