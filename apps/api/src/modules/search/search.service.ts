import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export type SearchKind =
  | 'ticket'
  | 'person'
  | 'space'
  | 'room'
  | 'location'
  | 'asset'
  | 'vendor'
  | 'team'
  | 'request_type';

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  breadcrumb: string | null;
  score: number;
  extra: Record<string, unknown> | null;
}

export interface SearchResponse {
  query: string;
  total: number;
  groups: Record<string, SearchHit[]>;
}

interface RpcRow {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  breadcrumb: string | null;
  score: number;
  extra: Record<string, unknown> | null;
}

@Injectable()
export class SearchService {
  constructor(private readonly supabase: SupabaseService) {}

  async search(
    authUid: string,
    q: string,
    types?: SearchKind[],
    perTypeLimit = 4,
  ): Promise<SearchResponse> {
    const trimmed = q.trim();
    const empty: SearchResponse = { query: trimmed, total: 0, groups: {} };
    if (trimmed.length < 2) return empty;

    const tenant = TenantContext.current();

    // Resolve auth_uid → users.id (one cheap lookup; the heavy work is the RPC).
    const { data: userRow } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();

    if (!userRow?.id) return empty;

    const { data, error } = await this.supabase.admin.rpc('search_global', {
      p_user_id: userRow.id,
      p_tenant_id: tenant.id,
      p_q: trimmed,
      p_types: types && types.length > 0 ? types : null,
      p_per_type_limit: Math.min(Math.max(perTypeLimit, 1), 20),
    });

    if (error) throw error;

    const rows = (data ?? []) as RpcRow[];
    const groups: Record<string, SearchHit[]> = {};
    for (const row of rows) {
      const bucket = groups[row.kind] ?? (groups[row.kind] = []);
      bucket.push(row);
    }

    return { query: trimmed, total: rows.length, groups };
  }
}
