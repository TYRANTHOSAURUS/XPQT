import { BadRequestException } from '@nestjs/common';
import type { SupabaseService } from './supabase/supabase.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cap on the number of uuids passed to `.in()` in a single SELECT. PostgREST
 * encodes the IN-list into the URL as `id=in.(<comma-separated>)`, and the
 * Supabase platform proxy enforces a URL ceiling well below the absolute
 * Postgres + PostgREST limit (~16KB). 200 uuids ≈ 7,400 chars including
 * commas — comfortably under any real-world proxy ceiling, and far above
 * any sane per-ticket watcher list. If product later wants higher (bulk
 * import flow), chunk in the caller and aggregate the responses.
 */
const MAX_WATCHER_IDS_PER_QUERY = 200;

/**
 * Validate that every uuid in `watchers` references a real `persons` row in
 * the calling tenant. Pre-filters malformed uuids (returns a clean 400 with
 * the offending values rather than letting Postgres surface a 22P02 cast
 * error as a 500 with leaked detail). Caps the array length so a malicious
 * 1000-uuid bulk write doesn't blow the proxy URL ceiling.
 *
 * Closes the GHOST-uuid vector on the watchers column. Does NOT close the
 * within-tenant unauthorized-share vector (writing another in-tenant
 * person's real uuid as a watcher) — that's a product decision about
 * subscriber semantics, not a validation problem.
 *
 * Free function (vs. service-method) so both `TicketService.update` and
 * `WorkOrderService.updateMetadata` import the same canonical impl. Keeping
 * it stateless means neither service needs to depend on the other and there
 * is no Nest cyclic-dep issue.
 */
export async function validateWatcherIdsInTenant(
  supabase: SupabaseService,
  watchers: string[] | null | undefined,
  tenantId: string,
  options: { skipForSystemActor?: boolean } = {},
): Promise<void> {
  if (options.skipForSystemActor) return;
  if (!watchers || watchers.length === 0) return;

  if (!Array.isArray(watchers) || !watchers.every((w) => typeof w === 'string')) {
    throw new BadRequestException(
      'watchers must be an array of strings (person UUIDs) or null',
    );
  }

  const unique = [...new Set(watchers)];

  if (unique.length > MAX_WATCHER_IDS_PER_QUERY) {
    throw new BadRequestException(
      `watchers array too large (${unique.length}); maximum is ${MAX_WATCHER_IDS_PER_QUERY} unique uuids per request`,
    );
  }

  // Pre-filter malformed uuids. Without this, supabase-js + PostgREST send
  // the malformed string to Postgres which throws a 22P02 cast error; the
  // service rethrows the raw PostgrestError as a 500 with PG detail leaking
  // through. Surface as a clean 400 with the offending values listed.
  const malformed = unique.filter((id) => !UUID_RE.test(id));
  if (malformed.length > 0) {
    const sample = malformed.slice(0, 5).join(', ');
    throw new BadRequestException(
      `watchers contain ${malformed.length} malformed uuid(s): ${sample}${malformed.length > 5 ? ', ...' : ''}`,
    );
  }

  const { data, error } = await supabase.admin
    .from('persons')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('id', unique);
  if (error) throw error;

  const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  const invalid = unique.filter((id) => !found.has(id));
  if (invalid.length > 0) {
    const sample = invalid.slice(0, 5).join(', ');
    throw new BadRequestException(
      `watchers contain ${invalid.length} unknown person id(s) for this tenant: ${sample}${invalid.length > 5 ? ', ...' : ''} (note: watchers expects persons.id, not users.id)`,
    );
  }
}
