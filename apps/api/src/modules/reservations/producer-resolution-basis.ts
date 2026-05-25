import type { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors } from '../../common/errors';

type LoggerLike = {
  warn: (message: string) => void;
};

/**
 * Claims the canonical "now" used while producing idempotency-hashed
 * booking plans. The value is persisted by (tenant_id, idempotency_key), so a
 * retry that crosses lead-time rule boundaries rebuilds the same logical
 * payload instead of tripping attach_operations.payload_mismatch.
 */
export async function claimProducerResolutionBasis(args: {
  supabase: SupabaseService;
  tenantId: string;
  idempotencyKey: string;
  producer: string;
  log?: LoggerLike;
}): Promise<string> {
  const { data, error } = await args.supabase.admin.rpc(
    'claim_producer_resolution_basis',
    {
      p_tenant_id: args.tenantId,
      p_idempotency_key: args.idempotencyKey,
    },
  );

  if (error) {
    throw AppErrors.server('command_operations.unexpected_state', {
      detail:
        `${args.producer}: claim_producer_resolution_basis failed for ` +
        `idempotency_key=${args.idempotencyKey}`,
      cause: error,
    });
  }

  const raw = unwrapBasis(data);
  if (raw) return new Date(raw).toISOString();

  // Real PostgREST scalar RPC calls return a value for this function. This
  // fallback keeps older narrow unit mocks from failing on an impossible
  // production shape while still failing closed on any real RPC error above.
  const fallback = new Date().toISOString();
  args.log?.warn(
    `${args.producer}: claim_producer_resolution_basis returned no data; ` +
      `using process timestamp fallback for idempotency_key=${args.idempotencyKey}`,
  );
  return fallback;
}

function unwrapBasis(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    const first = data[0] as unknown;
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      const row = first as Record<string, unknown>;
      const value =
        row.claim_producer_resolution_basis ??
        row.basis_at ??
        Object.values(row)[0];
      return typeof value === 'string' ? value : null;
    }
  }
  if (data && typeof data === 'object') {
    const row = data as Record<string, unknown>;
    const value =
      row.claim_producer_resolution_basis ??
      row.basis_at ??
      Object.values(row)[0];
    return typeof value === 'string' ? value : null;
  }
  return null;
}
