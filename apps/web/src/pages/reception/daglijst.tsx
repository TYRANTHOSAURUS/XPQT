/**
 * /reception/daglijst — printable A4 day-list.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.8
 *
 * Reception traditionally works off a printed daily list during peak rush
 * (Q8a UX research finding). This page renders today's expected/arrived
 * visitors in a paper-friendly layout with a signature column on the
 * right.
 *
 * Print stylesheet rules:
 *   - `@page` declares A4 + 1cm margins.
 *   - `print:hidden` hides the workspace top bar + the in-app print
 *     button when the user runs `window.print()`.
 *   - `print:break-inside-avoid` keeps each row on a single page.
 *
 * No PDF library — browsers' "Print to PDF" works fine and keeps the
 * footprint zero.
 */
import { useEffect } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useReceptionBuilding } from '@/components/desk/desk-building-context';
import {
  formatPrimaryHost,
  formatReceptionRowName,
  useReceptionDaglijst,
} from '@/api/visitors/reception';
import { formatDayLabel, formatShortDate, formatTimeShort } from '@/lib/format';

export function ReceptionDaglijstPage() {
  const { buildingId, buildings, loading: buildingsLoading } = useReceptionBuilding();
  const { data, isLoading, isError } = useReceptionDaglijst(buildingId);

  const todayDate = new Date();
  const dayLabel = formatDayLabel(todayDate);

  // Set the document title to something useful for the print dialog's
  // "save as" filename. Restore on unmount.
  useEffect(() => {
    const prev = document.title;
    document.title = `Daglijst — ${formatShortDate(new Date())}`;
    return () => {
      document.title = prev;
    };
  }, []);

  const buildingName =
    buildings.find((b) => b.id === buildingId)?.name ?? 'Unknown building';

  if (!buildingsLoading && buildings.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-muted-foreground">
        No buildings in your reception scope.
      </div>
    );
  }

  return (
    <>
      {/* Page-scoped print stylesheet. Tailwind's print: variants cover most
           cases, but the @page rule has to be raw CSS. */}
      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 1cm;
          }
          body {
            background: white !important;
          }
        }
      `}</style>

      {/* In-app chrome: action bar above the printable sheet. */}
      <div className="mx-auto max-w-3xl px-6 py-6 print:hidden">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Print daglijst</h1>
            <p className="text-sm text-muted-foreground">
              {buildingName} — {dayLabel}
            </p>
          </div>
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden />
            Print
          </Button>
        </div>
      </div>

      {/* The printable sheet itself. Stays on screen as a preview.
           [color-scheme:light] forces a light-mode rendering inside the
           sheet even when the rest of the app is in dark mode — without
           it dark-mode users see white-on-near-black text in the preview,
           which doesn't match the printed page. */}
      <div className="mx-auto max-w-3xl bg-white px-6 pb-12 print:max-w-none print:px-0 print:pb-0 [color-scheme:light]">
        <div className="rounded-lg border bg-white p-8 print:rounded-none print:border-0 print:p-0">
          <header className="mb-6 border-b border-black pb-3 print:mb-4">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-gray-500">
                  Daglijst · Reception
                </div>
                <div className="text-2xl font-semibold text-black">
                  {buildingName}
                </div>
              </div>
              <div className="text-right text-sm text-gray-700">
                <div className="text-base font-medium">{dayLabel}</div>
                <div className="tabular-nums text-xs text-gray-500">
                  Generated {formatTimeShort(todayDate)}
                </div>
              </div>
            </div>
          </header>

          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}

          {isError && !isLoading && (
            <div className="text-sm text-red-700">
              Couldn't load today's list. Try refreshing.
            </div>
          )}

          {!isLoading && !isError && (data ?? []).length === 0 && (
            <div className="py-8 text-center text-sm text-gray-500">
              No visitors expected today.
            </div>
          )}

          {!isLoading && !isError && (data ?? []).length > 0 && (
            <table className="w-full text-sm text-black">
              <thead className="border-b border-gray-400 text-left text-xs uppercase tracking-wider text-gray-600">
                <tr>
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Visitor</th>
                  <th className="py-2 pr-3 font-medium">Company</th>
                  <th className="py-2 pr-3 font-medium">Host</th>
                  <th className="py-2 pr-3 font-medium">Pass</th>
                  <th className="py-2 font-medium">Signature</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((row) => {
                  const name = formatReceptionRowName(row);
                  const host = formatPrimaryHost(row) ?? '—';
                  const time = row.expected_at
                    ? formatTimeShort(row.expected_at)
                    : '';
                  return (
                    <tr
                      key={row.visitor_id}
                      className="border-b border-gray-200 align-top print:break-inside-avoid"
                    >
                      <td className="py-3 pr-3 tabular-nums font-medium">
                        {time}
                      </td>
                      <td className="py-3 pr-3">{name}</td>
                      <td className="py-3 pr-3 text-gray-700">
                        {row.company ?? '—'}
                      </td>
                      <td className="py-3 pr-3">{host}</td>
                      <td className="py-3 pr-3 tabular-nums text-gray-700">
                        {row.pass_number ? `#${row.pass_number}` : ''}
                      </td>
                      <td className="py-3" style={{ width: '180px' }}>
                        {/* Drawn line for handwritten check-off. */}
                        <div className="h-6 border-b border-gray-400" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <footer className="mt-6 text-xs text-gray-500 print:mt-4">
            Tick the signature box when the visitor arrives. Reconcile with
            the digital list at the end of the shift.
          </footer>
        </div>
      </div>
    </>
  );
}
