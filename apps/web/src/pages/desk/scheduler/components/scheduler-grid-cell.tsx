// Empty-cell visuals are rendered by the row as a single flat layer
// because absolutely-positioning N×M cells would torpedo perf at 50 rooms
// × 7 days × 24 columns. The row paints a deterministic CSS background
// (`linear-gradient` of vertical hairlines + a hatching pattern for
// denied ranges); this file is intentionally minimal — it exposes a
// single helper that constructs that background from the cell-level
// outcome map. Keeping it in its own file makes the row component
// shorter and the helper unit-testable in a follow-up.

import type { RuleTagOutcome } from './scheduler-rule-tag';

export type CellOutcomeMap = Record<number, RuleTagOutcome>;

const HATCH_PATTERN =
  'repeating-linear-gradient(45deg, transparent 0 4px, rgba(127,127,127,0.10) 4px 8px)';

/**
 * Build a CSS `backgroundImage` value that paints denied / approval-needed
 * tints over the empty cells of a row. The values match the spec §4.4
 * differentiation: amber for require_approval, hatched dim for deny.
 *
 * Returns a single `style` object the row can spread on its empty layer.
 */
export function buildCellBackground(
  cellOutcomes: CellOutcomeMap,
  totalColumns: number,
): React.CSSProperties | undefined {
  const layers: string[] = [];
  for (const [cellStr, outcome] of Object.entries(cellOutcomes)) {
    const cell = Number(cellStr);
    if (Number.isNaN(cell)) continue;
    const start = (cell / totalColumns) * 100;
    const end = ((cell + 1) / totalColumns) * 100;
    if (outcome === 'deny') {
      layers.push(`linear-gradient(to right, rgba(239,68,68,0.06) 0 100%) ${start}% 0 / ${end - start}% 100% no-repeat`);
    } else if (outcome === 'require_approval') {
      layers.push(`linear-gradient(to right, rgba(245,158,11,0.10) 0 100%) ${start}% 0 / ${end - start}% 100% no-repeat`);
    } else if (outcome === 'warn') {
      layers.push(`linear-gradient(to right, rgba(234,179,8,0.10) 0 100%) ${start}% 0 / ${end - start}% 100% no-repeat`);
    }
  }
  if (layers.length === 0) return undefined;
  return {
    backgroundImage: layers.join(', '),
  };
}

export { HATCH_PATTERN };
