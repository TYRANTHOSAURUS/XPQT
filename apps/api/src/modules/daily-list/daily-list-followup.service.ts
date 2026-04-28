import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { DailyListEventType } from './event-types';

/**
 * Desk-side follow-up workflow for post-cutoff order_line_item edits.
 * Counterpart to the DB trigger in 00178: when a locked line is edited,
 * the trigger flips `requires_phone_followup = true`. The desk operator
 * picks up the flag from the dashboard widget, calls the vendor by
 * phone, then "Confirm phoned" stamps the row so it disappears from the
 * widget (until the line is edited again).
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §7,§10.
 */
@Injectable()
export class DailyListFollowupService {
  constructor(
    private readonly db: DbService,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  /**
   * List rows that need phone follow-up. Grouped at the API layer (not
   * the DB) so the desk widget can render vendor-by-vendor.
   *
   * Filters out:
   *   - rows already confirmed (desk_confirmed_phoned_at IS NOT NULL).
   *     The DB trigger resets these on every fresh edit, so filtering
   *     here is just a safety net.
   *   - rows whose service window is more than 24h in the past (already
   *     delivered or stale; not actionable).
   */
  async listPostCutoffChanges(tenantId: string): Promise<PostCutoffGroup[]> {
    const rows = await this.db.queryMany<PostCutoffRow>(
      `select
         oli.id                       as line_id,
         oli.order_id                 as order_id,
         oli.tenant_id                as tenant_id,
         oli.vendor_id                as vendor_id,
         coalesce(v.name, '(unknown vendor)')        as vendor_name,
         coalesce(v.phone_number, '(no phone)')      as vendor_phone,
         oli.catalog_item_id          as catalog_item_id,
         coalesce(ci.name, '(unknown item)')         as catalog_item_name,
         oli.quantity                 as quantity,
         oli.dietary_notes            as dietary_notes,
         oli.fulfillment_status       as fulfillment_status,
         oli.fulfillment_notes        as fulfillment_notes,
         oli.daglijst_locked_at       as locked_at,
         oli.daglijst_id              as daglijst_id,
         oli.service_window_start_at  as service_window_start_at,
         /* Requester first name only — same privacy posture as the
            daglijst itself (spec §13). */
         p.first_name                 as requester_first_name,
         coalesce(s_room.name, '(no room)')          as room_name
       from public.order_line_items oli
       left join public.vendors v
              on v.tenant_id = oli.tenant_id and v.id = oli.vendor_id
       left join public.catalog_items ci
              on ci.tenant_id = oli.tenant_id and ci.id = oli.catalog_item_id
       left join public.orders ord
              on ord.tenant_id = oli.tenant_id and ord.id = oli.order_id
       left join public.persons p
              on p.tenant_id = oli.tenant_id and p.id = ord.requester_person_id
       left join public.spaces s_room
              on s_room.tenant_id = oli.tenant_id
             and s_room.id = ord.delivery_location_id
        where oli.tenant_id = $1
          and oli.requires_phone_followup = true
          and oli.desk_confirmed_phoned_at is null
          and (oli.service_window_start_at is null
               or oli.service_window_start_at >= now() - interval '24 hours')
        order by v.name nulls last, oli.service_window_start_at nulls last`,
      [tenantId],
    );

    /* Group by vendor at the application layer. Caller renders one card
       per vendor in the desk widget; lines within a card stay sorted
       by service window. */
    const byVendor = new Map<string, PostCutoffGroup>();
    for (const row of rows) {
      const key = row.vendor_id ?? '(unassigned)';
      let group = byVendor.get(key);
      if (!group) {
        group = {
          vendor_id: row.vendor_id,
          vendor_name: row.vendor_name,
          vendor_phone: row.vendor_phone,
          line_count: 0,
          lines: [],
        };
        byVendor.set(key, group);
      }
      group.lines.push({
        line_id: row.line_id,
        order_id: row.order_id,
        catalog_item_id: row.catalog_item_id,
        catalog_item_name: row.catalog_item_name,
        quantity: row.quantity,
        dietary_notes: row.dietary_notes,
        fulfillment_status: row.fulfillment_status,
        fulfillment_notes: row.fulfillment_notes,
        locked_at: row.locked_at,
        daglijst_id: row.daglijst_id,
        service_window_start_at: row.service_window_start_at,
        requester_first_name: row.requester_first_name,
        room_name: row.room_name,
      });
      group.line_count = group.lines.length;
    }
    return Array.from(byVendor.values());
  }

  /**
   * Confirm a single line was phoned through. Stamps
   * desk_confirmed_phoned_at + by-user, clears requires_phone_followup,
   * and emits the OrderPhoneFollowupConfirmed audit event so vendor
   * scorecards (Sprint 4 status inference + Phase B portal) can see the
   * full follow-up history.
   *
   * Idempotent on already-confirmed rows: returns the existing
   * confirmation without re-emitting audit. The DB trigger ensures a
   * subsequent edit re-flags the line, so a second confirmation is a
   * legitimate distinct event then.
   */
  async confirmPhoned(args: ConfirmPhonedArgs): Promise<{ confirmed_at: string }> {
    const { tenantId, lineId, userId } = args;

    return this.db.tx(async (client) => {
      const updated = await client.query<{
        id: string;
        desk_confirmed_phoned_at: string;
        was_already_confirmed: boolean;
      }>(
        `update public.order_line_items
            set desk_confirmed_phoned_at      = case
                  when desk_confirmed_phoned_at is not null then desk_confirmed_phoned_at
                  else now()
                end,
                desk_confirmed_phoned_by_user_id = case
                  when desk_confirmed_phoned_at is not null then desk_confirmed_phoned_by_user_id
                  else $3
                end,
                requires_phone_followup        = false
          where tenant_id = $1
            and id = $2
            and requires_phone_followup = true
          returning id,
                    desk_confirmed_phoned_at,
                    /* True if the row was ALREADY confirmed before this
                       UPDATE — used to skip the audit emit on no-ops. */
                    (xmax::text = '0')::boolean as was_already_confirmed`,
        [tenantId, lineId, userId],
      );
      if (updated.rowCount === 0) {
        /* Either the line doesn't exist, doesn't belong to this tenant,
           or is already not flagged. Distinguish so the UI can show the
           right message. */
        const exists = await client.query(
          `select 1 from public.order_line_items
            where tenant_id = $1 and id = $2 limit 1`,
          [tenantId, lineId],
        );
        if (exists.rowCount === 0) {
          throw new NotFoundException(`Line ${lineId} not found`);
        }
        throw new BadRequestException({
          code: 'not_flagged',
          message: 'Line is not flagged for phone follow-up.',
        });
      }
      const row = updated.rows[0];
      await this.auditOutbox.emitTx(client, {
        tenantId,
        eventType: DailyListEventType.OrderPhoneFollowupConfirmed,
        entityType: 'order_line_items',
        entityId: lineId,
        actorUserId: userId,
        details: { confirmed_at: row.desk_confirmed_phoned_at },
      });
      return { confirmed_at: row.desk_confirmed_phoned_at };
    });
  }
}

export interface ConfirmPhonedArgs {
  tenantId: string;
  lineId: string;
  userId: string;
}

export interface PostCutoffGroup {
  vendor_id: string | null;
  vendor_name: string;
  vendor_phone: string;
  line_count: number;
  lines: PostCutoffLine[];
}

export interface PostCutoffLine {
  line_id: string;
  order_id: string;
  catalog_item_id: string | null;
  catalog_item_name: string;
  quantity: number;
  dietary_notes: string | null;
  fulfillment_status: string | null;
  fulfillment_notes: string | null;
  locked_at: string | null;
  daglijst_id: string | null;
  service_window_start_at: string | null;
  requester_first_name: string | null;
  room_name: string;
}

interface PostCutoffRow extends PostCutoffLine {
  tenant_id: string;
  vendor_id: string | null;
  vendor_name: string;
  vendor_phone: string;
}
