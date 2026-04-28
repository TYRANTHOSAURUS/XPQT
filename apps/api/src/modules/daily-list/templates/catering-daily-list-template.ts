import { createElement } from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { DailyListPayload } from '../daily-list.service';

/**
 * NL-localised catering daglijst PDF template (v1).
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §5.
 *
 * Constraints baked into the layout:
 *   - Single-page-per-bucket where possible; spans pages cleanly when long.
 *   - Black-and-white friendly (vendors print on cheap printers); no color
 *     dependency for legibility.
 *   - Times in CET (vendor-local) per the spec; the assemble service
 *     emits ISO timestamps; the template formats locally.
 *   - First name only on requester (privacy guidance from the spec).
 *   - Allergen / dietary notes prominent — the kitchen staples a
 *     printout in front of the prep station.
 *
 * Sprint 4 will add FR + EN templates per the i18n stack pattern.
 * Today's NL strings are inline; refactor into a string-bundle when the
 * second locale lands.
 */

const styles = StyleSheet.create({
  page: {
    flexDirection: 'column',
    paddingTop: 30,
    paddingBottom: 36,
    paddingHorizontal: 36,
    fontFamily: 'Helvetica',
    fontSize: 10,
  },
  header: {
    borderBottom: '1pt solid #000',
    paddingBottom: 8,
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 11,
    color: '#444',
    marginBottom: 2,
  },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
    columnGap: 16,
  },
  metaItem: {
    fontSize: 9,
    color: '#444',
  },
  metaItemValue: {
    fontFamily: 'Helvetica-Bold',
    color: '#000',
  },
  totalsBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingVertical: 6,
    borderTop: '0.5pt solid #999',
    borderBottom: '0.5pt solid #999',
  },
  totalsLabel: { fontSize: 9, color: '#444' },
  totalsValue: { fontSize: 11, fontFamily: 'Helvetica-Bold' },
  lineBlock: {
    marginBottom: 12,
    paddingBottom: 8,
    borderBottom: '0.5pt solid #ccc',
  },
  lineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  lineTime: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
  },
  lineLocation: {
    fontSize: 10,
    color: '#222',
  },
  lineRequester: {
    fontSize: 9,
    color: '#666',
    marginBottom: 4,
  },
  itemRow: {
    flexDirection: 'row',
    paddingVertical: 1,
  },
  itemQuantity: {
    width: 30,
    textAlign: 'right',
    paddingRight: 8,
    fontFamily: 'Helvetica-Bold',
  },
  itemName: { flex: 1 },
  diet: {
    marginTop: 3,
    padding: 4,
    backgroundColor: '#f4f4f0',
    fontSize: 9,
    color: '#555',
  },
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 36,
    right: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: '#666',
    paddingTop: 6,
    borderTop: '0.5pt solid #ccc',
  },
});

export interface CateringDailyListTemplateProps {
  payload: DailyListPayload;
  /** Generation metadata surfaced in the header. */
  generation: {
    version: number;
    generated_at: string;
    triggered_by: 'auto' | 'admin_manual';
  };
}

/**
 * Format a delivery-time-ish input as HH:mm in Europe/Amsterdam. Three
 * shapes come from upstream queries + payload assembly:
 *   - 'HH:mm:ss'   (postgres `time` cast to text — the common case)
 *   - 'HH:mm'      (admin-edited)
 *   - ISO timestamp (when assemble pulls from requested_for_start_at,
 *                    or generation.generated_at)
 *
 * The Sprint 2 fix replaced `new Date('12:00')` (which was NaN in Node
 * and rendered every cell as '—'). Codex round-2 review flagged that the
 * ISO branch still used `getHours()/getMinutes()` which is process-tz
 * dependent — a server in UTC would render `generated_at` an hour off
 * the vendor's wall clock. Fix: format ISO inputs in Europe/Amsterdam
 * explicitly via Intl.DateTimeFormat. Tenant-configurable timezone is a
 * Sprint 4 follow-up; today every Benelux vendor is on Amsterdam local
 * (matches the scheduler's bucket math).
 */
const AMSTERDAM_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Amsterdam',
});

function formatTime(input: string | null | undefined): string {
  if (!input) return '—';

  // 'HH:mm' or 'HH:mm:ss' — naive postgres `time`, already in vendor-local.
  // Pull the first two components verbatim.
  const timeOnly = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(input);
  if (timeOnly) {
    return `${timeOnly[1]}:${timeOnly[2]}`;
  }

  // ISO with 'T' / full timestamp — Date parsing is defined. Render in
  // Europe/Amsterdam so generated_at always reads as the vendor's wall
  // clock regardless of the API server's TZ.
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return AMSTERDAM_TIME_FMT.format(d);
}

function formatDateNL(ymd: string): string {
  // 2026-05-01 → "1 mei 2026"
  const months = [
    'januari', 'februari', 'maart', 'april', 'mei', 'juni',
    'juli', 'augustus', 'september', 'oktober', 'november', 'december',
  ];
  const [y, m, d] = ymd.split('-').map((n) => Number(n));
  if (!y || !m || !d) return ymd;
  return `${d} ${months[m - 1]} ${y}`;
}

/**
 * The template is exported as a function returning a `Document` element.
 * `@react-pdf/renderer` consumes the element + emits a buffer.
 */
export function CateringDailyListTemplate(props: CateringDailyListTemplateProps) {
  const { payload, generation } = props;
  const buildingLabel = payload.building?.name ?? 'Alle gebouwen';

  return createElement(
    Document,
    {
      title: `Daily-list ${payload.vendor.name} ${payload.list_date}`,
      author: 'Prequest',
      subject: `Catering daglijst ${payload.list_date}`,
    },
    createElement(
      Page,
      { size: 'A4', style: styles.page },

      // --- Header ---
      createElement(
        View,
        { style: styles.header, fixed: true },
        createElement(Text, { style: styles.title }, 'Daily-list catering'),
        createElement(Text, { style: styles.subtitle }, `${formatDateNL(payload.list_date)} · ${buildingLabel}`),
        createElement(Text, { style: styles.subtitle }, `Voor ${payload.vendor.name}`),
        createElement(
          View,
          { style: styles.meta },
          createElement(
            Text,
            { style: styles.metaItem },
            'Versie ',
            createElement(Text, { style: styles.metaItemValue }, `v${generation.version}`),
          ),
          createElement(
            Text,
            { style: styles.metaItem },
            'Aangemaakt ',
            createElement(Text, { style: styles.metaItemValue }, formatTime(generation.generated_at)),
          ),
          createElement(
            Text,
            { style: styles.metaItem },
            'Bron ',
            createElement(
              Text,
              { style: styles.metaItemValue },
              generation.triggered_by === 'auto' ? 'automatisch' : 'handmatig',
            ),
          ),
        ),
        createElement(
          View,
          { style: styles.totalsBar },
          createElement(
            Text,
            null,
            createElement(Text, { style: styles.totalsLabel }, 'Bestellingen: '),
            createElement(Text, { style: styles.totalsValue }, `${payload.total_lines}`),
          ),
          createElement(
            Text,
            null,
            createElement(Text, { style: styles.totalsLabel }, 'Totale hoeveelheid: '),
            createElement(Text, { style: styles.totalsValue }, `${payload.total_quantity}`),
          ),
        ),
      ),

      // --- Lines (one block per order line) ---
      ...payload.lines.map((line, idx) =>
        createElement(
          View,
          { key: idx, style: styles.lineBlock, wrap: false },
          createElement(
            View,
            { style: styles.lineHeader },
            createElement(Text, { style: styles.lineTime }, formatTime(line.delivery_time)),
            createElement(Text, { style: styles.lineLocation }, line.delivery_location_name ?? '—'),
          ),
          createElement(
            Text,
            { style: styles.lineRequester },
            line.requester_first_name
              ? `Voor ${line.requester_first_name}`
              : 'Voor: onbekend',
            line.headcount ? ` · ${line.headcount} personen` : '',
          ),
          createElement(
            View,
            { style: styles.itemRow },
            createElement(Text, { style: styles.itemQuantity }, `${line.quantity}×`),
            createElement(Text, { style: styles.itemName }, line.catalog_item_name ?? 'Item'),
          ),
          line.dietary_notes
            ? createElement(
                View,
                { style: styles.diet },
                createElement(Text, null, `Dieetwensen: ${line.dietary_notes}`),
              )
            : null,
        ),
      ),

      // --- Footer ---
      createElement(
        View,
        { style: styles.footer, fixed: true },
        createElement(Text, null, 'Geleverd via Prequest'),
        createElement(
          Text,
          null,
          `Pagina `,
          createElement(Text, {
            render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              `${pageNumber} van ${totalPages}`,
          }),
        ),
      ),
    ),
  );
}
